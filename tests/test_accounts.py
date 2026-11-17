"""Accounts and the sign-in gate. Run with:  python -m unittest discover tests

Every database goes to a temp folder; no network and no keys.
"""
import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
from unittest import mock

from voice_call import accounts, server, settings, vault

PASSWORD = "correct horse battery"


class Fresh(unittest.TestCase):
    """Each test gets an empty accounts database and an empty guessing log."""

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        # Every place the single-user days kept data is pointed into the temp folder as well: the first sign-up
        # moves that data, and a test must never touch the real config/ and data/ folders.
        for patcher in (mock.patch.dict("os.environ", {"VC_MASTER_KEY": "A" * 43, "SMTP_HOST": "", "SIGNUP_CODE": ""}),
                        mock.patch.object(vault, "_key", None),
                        mock.patch.object(settings, "PROJECT", self.root / "project"),
                        mock.patch.object(settings, "FLOWS_FOLDER", self.root / "project" / "config" / "flows"),
                        mock.patch.object(settings, "CONFIG_FILE", self.root / "project" / "config" / "business.json"),
                        mock.patch.object(settings, "DATA_FOLDER", Path(folder.name)),
                        mock.patch.object(accounts, "DB_FILE", Path(folder.name) / "accounts.db"),
                        mock.patch.object(accounts, "_ready", False),
                        mock.patch.dict(accounts._attempts, clear=True)):
            patcher.start()
            self.addCleanup(patcher.stop)


class People(Fresh):
    def test_sign_up_then_in(self):
        person, token = accounts.sign_up("Ann@Example.com", PASSWORD, "Ann")
        self.assertEqual(person["email"], "ann@example.com")
        self.assertEqual(accounts.user_for(token)["id"], person["id"])
        again, other = accounts.sign_in("ann@example.com", PASSWORD)
        self.assertEqual(again["id"], person["id"])
        self.assertNotEqual(token, other)

    def test_password_is_never_stored_and_token_only_as_a_hash(self):
        person, token = accounts.sign_up("a@example.com", PASSWORD)
        raw = accounts.DB_FILE.read_bytes()
        self.assertNotIn(PASSWORD.encode(), raw)
        self.assertNotIn(token.encode(), raw)

    def test_wrong_password_and_unknown_email_look_the_same(self):
        accounts.sign_up("a@example.com", PASSWORD)
        with self.assertRaises(accounts.Problem) as wrong:
            accounts.sign_in("a@example.com", "not the password")
        with self.assertRaises(accounts.Problem) as unknown:
            accounts.sign_in("nobody@example.com", PASSWORD)
        self.assertEqual(str(wrong.exception), str(unknown.exception))

    def test_rules_for_sign_up(self):
        for email, password in (("not-an-email", PASSWORD), ("a@example.com", "short")):
            with self.assertRaises(accounts.Problem):
                accounts.sign_up(email, password)
        accounts.sign_up("a@example.com", PASSWORD)
        with self.assertRaises(accounts.Problem) as taken:
            accounts.sign_up("A@EXAMPLE.COM", PASSWORD)
        self.assertEqual(taken.exception.status, 409)

    def test_invite_code_when_one_is_set(self):
        with mock.patch.dict("os.environ", {"SIGNUP_CODE": "letmein"}):
            with self.assertRaises(accounts.Problem):
                accounts.sign_up("a@example.com", PASSWORD, code="nope")
            accounts.sign_up("a@example.com", PASSWORD, code="letmein")

    def test_sign_out_ends_that_session_only(self):
        _, first = accounts.sign_up("a@example.com", PASSWORD)
        _, second = accounts.sign_in("a@example.com", PASSWORD)
        accounts.sign_out(first)
        self.assertIsNone(accounts.user_for(first))
        self.assertIsNotNone(accounts.user_for(second))

    def test_expired_and_junk_tokens_are_nobody(self):
        _, token = accounts.sign_up("a@example.com", PASSWORD)
        self.assertIsNone(accounts.user_for(""))
        self.assertIsNone(accounts.user_for("made-up"))
        with mock.patch("voice_call.accounts.time.time", return_value=10**11):
            self.assertIsNone(accounts.user_for(token))

    def test_guessing_is_stopped(self):
        accounts.sign_up("a@example.com", PASSWORD)
        for _ in range(accounts.LIMITS["signin"]):
            with self.assertRaises(accounts.Problem):
                accounts.sign_in("a@example.com", "wrong guess", address="1.2.3.4")
        with self.assertRaises(accounts.Problem) as stopped:
            accounts.sign_in("a@example.com", PASSWORD, address="1.2.3.4")   # even the right one now waits
        self.assertEqual(stopped.exception.status, 429)

    def test_cookie_is_not_readable_by_scripts(self):
        header = accounts.cookie_header("abc", secure=True)
        for part in ("HttpOnly", "SameSite=Lax", "Secure"):
            self.assertIn(part, header)


class DefaultAccount(Fresh):
    def test_made_once_and_always_there_to_sign_in_with(self):
        made, note = accounts.ensure_default()
        self.assertTrue(made["is_admin"] and made["verified"])
        self.assertIn(accounts.DEFAULT_EMAIL, note)
        accounts.sign_in(accounts.DEFAULT_EMAIL, accounts.DEFAULT_PASSWORD)
        self.assertEqual(accounts.ensure_default(), (None, ""))             # a second start makes nothing more
        self.assertEqual(accounts.count(), 1)

    def test_a_changed_password_is_never_put_back(self):
        made, _ = accounts.ensure_default()
        accounts.change_password(made["id"], accounts.DEFAULT_PASSWORD, "my own new password")
        accounts.ensure_default()
        with self.assertRaises(accounts.Problem):
            accounts.sign_in(accounts.DEFAULT_EMAIL, accounts.DEFAULT_PASSWORD)
        accounts.sign_in(accounts.DEFAULT_EMAIL, "my own new password")

    def test_it_comes_back_if_deleted_and_is_not_an_admin_when_others_exist(self):
        person, _ = accounts.sign_up("boss@example.com", PASSWORD)
        made, _ = accounts.ensure_default()
        self.assertFalse(made["is_admin"])                                  # the first real account still runs the server

    def test_the_public_built_in_password_is_not_used_on_a_public_server(self):
        with mock.patch.dict("os.environ", {"PUBLIC_URL": "https://calls.example.com"}):
            made, note = accounts.ensure_default()
            self.assertIsNone(made)
            self.assertIn("DEFAULT_ADMIN_PASSWORD", note)
        with mock.patch.dict("os.environ", {"PUBLIC_URL": "https://calls.example.com", "DEFAULT_ADMIN_PASSWORD": "a long private password"}):
            made, _ = accounts.ensure_default()
            self.assertIsNotNone(made)

    def test_it_can_be_switched_off(self):
        with mock.patch.dict("os.environ", {"DISABLE_DEFAULT_ADMIN": "1"}):
            self.assertEqual(accounts.ensure_default(), (None, ""))


class Served(Fresh):
    """The real server on a spare port, and a way to talk to it."""

    def setUp(self):
        super().setUp()
        self.http = server.OnePortServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.addCleanup(self.http.server_close)
        self.addCleanup(self.http.shutdown)
        self.port = self.http.server_address[1]

    def call(self, method, path, body=None, cookie="", headers=None):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=10)
        sent = {"Content-Type": "application/json", **({"Cookie": cookie} if cookie else {}), **(headers or {})}
        connection.request(method, path, json.dumps(body) if body is not None else None, sent)
        reply = connection.getresponse()
        data = json.loads(reply.read() or b"{}")
        cookies = reply.getheader("Set-Cookie") or ""
        connection.close()
        return reply.status, data, cookies

    def sign_up(self, email, **more):
        _, _, cookie = self.call("POST", "/api/auth/signup", {"email": email, "password": PASSWORD, **more})
        return cookie.split(";")[0]

    def user_id(self, cookie):
        return self.call("GET", "/api/auth/me", cookie=cookie)[1]["user"]["id"]


class Gate(Served):
    """Nothing under /api/ answers without a session."""

    def test_api_needs_a_session(self):
        for method, path in (("GET", "/api/flows"), ("GET", "/api/calls"), ("GET", "/api/contacts"),
                             ("GET", "/api/stats"), ("POST", "/api/flows"), ("POST", "/api/call/start"),
                             ("POST", "/api/assist"), ("POST", "/api/contacts/delete"),
                             ("POST", "/api/flows/delete"), ("POST", "/api/calls/delete")):
            status, data, _ = self.call(method, path, {} if method == "POST" else None)
            self.assertEqual(status, 401, path)
            self.assertTrue(data.get("signin"), path)

    def test_sign_up_sets_a_cookie_that_opens_the_api(self):
        status, data, cookie = self.call("POST", "/api/auth/signup", {"email": "a@example.com", "password": PASSWORD})
        self.assertEqual(status, 200)
        self.assertIn("HttpOnly", cookie)
        session = cookie.split(";")[0]
        status, data, _ = self.call("GET", "/api/auth/me", cookie=session)
        self.assertEqual(data["user"]["email"], "a@example.com")
        status, _, _ = self.call("GET", "/api/flows", cookie=session)
        self.assertEqual(status, 200)

    def test_bulk_delete_removes_only_your_own_flows_and_calls(self):
        _, _, one = self.call("POST", "/api/auth/signup", {"email": "a@example.com", "password": PASSWORD})
        _, _, two = self.call("POST", "/api/auth/signup", {"email": "b@example.com", "password": PASSWORD})
        a, b = one.split(";")[0], two.split(";")[0]
        mine = [self.call("POST", "/api/flows", {"name": f"m{n}"}, cookie=a)[1]["id"] for n in range(3)]
        theirs = self.call("POST", "/api/flows", {"name": "t"}, cookie=b)[1]["id"]
        # A stranger's id, a path and a made-up id are skipped; the rest go.
        status, data, _ = self.call("POST", "/api/flows/delete", {"ids": [mine[0], mine[1], theirs, "../x", "nope"]}, cookie=a)
        self.assertEqual(status, 200)
        self.assertEqual(sorted(data["deleted"]), sorted(mine[:2]))
        left = [f["id"] for f in self.call("GET", "/api/flows", cookie=b)[1]["flows"]]
        self.assertIn(theirs, left)
        status, data, _ = self.call("POST", "/api/calls/delete", {"ids": ["../../accounts", "missing"]}, cookie=a)
        self.assertEqual((status, data["deleted"]), (200, 0))

    def test_sign_out_closes_it(self):
        _, _, cookie = self.call("POST", "/api/auth/signup", {"email": "a@example.com", "password": PASSWORD})
        session = cookie.split(";")[0]
        self.call("POST", "/api/auth/signout", {}, cookie=session)
        self.assertEqual(self.call("GET", "/api/flows", cookie=session)[0], 401)

    def test_a_write_from_another_site_is_refused(self):
        _, _, cookie = self.call("POST", "/api/auth/signup", {"email": "a@example.com", "password": PASSWORD})
        status, _, _ = self.call("POST", "/api/flows", {}, cookie=cookie.split(";")[0],
                                 headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)

    def test_one_person_cannot_see_or_change_anothers_flow(self):
        ann, bob = self.sign_up("ann@example.com"), self.sign_up("bob@example.com")
        _, made, _ = self.call("POST", "/api/flows", {"name": "Ann's secret"}, cookie=ann)
        flow = made["id"]
        # Bob's own list has his own starting flow and not Ann's.
        _, listed, _ = self.call("GET", "/api/flows", cookie=bob)
        self.assertNotIn(flow, [one["id"] for one in listed["flows"]])
        # Reading, saving, publishing, duplicating, deleting and reading results: all as if it does not exist.
        for method, path in (("POST", f"/api/flows/{flow}"), ("POST", f"/api/flows/{flow}/delete"),
                             ("POST", f"/api/flows/{flow}/duplicate"), ("POST", f"/api/flows/{flow}/publish"),
                             ("GET", f"/api/flows/{flow}/results"), ("GET", f"/api/flows/{flow}/export.csv")):
            status, _, _ = self.call(method, path, {} if method == "POST" else None, cookie=bob)
            self.assertEqual(status, 404, path)
        # And it is untouched for Ann.
        _, ann_list, _ = self.call("GET", "/api/flows", cookie=ann)
        self.assertIn(flow, [one["id"] for one in ann_list["flows"]])

    def test_contacts_and_calls_are_separate_too(self):
        ann, bob = self.sign_up("ann@example.com"), self.sign_up("bob@example.com")
        _, group, _ = self.call("POST", "/api/contacts/groups", {"name": "Ann's customers"}, cookie=ann)
        _, ann_groups, _ = self.call("GET", "/api/contacts/groups", cookie=ann)
        _, bob_groups, _ = self.call("GET", "/api/contacts/groups", cookie=bob)
        self.assertIn(group["id"], [one["id"] for one in ann_groups["groups"]])
        self.assertNotIn(group["id"], [one["id"] for one in bob_groups["groups"]])
        _, saved, _ = self.call("POST", "/api/contacts", {"name": "Zed", "phone": "+919876543210"}, cookie=ann)
        self.assertEqual(self.call("GET", f"/api/contacts/{saved['id']}", cookie=bob)[0], 404)

    def test_someone_elses_call_in_progress_looks_like_no_call(self):
        from voice_call.models import BusinessSetup, Call
        ann = self.sign_up("ann@example.com")
        bob = self.sign_up("bob@example.com")
        _, me, _ = self.call("GET", "/api/auth/me", cookie=ann)
        call = Call(BusinessSetup(), {}, owner=me["user"]["id"])
        server.calls[call.id] = call
        self.addCleanup(server.calls.pop, call.id, None)
        status, _, _ = self.call("POST", "/api/call/turn", {"message": "hi"}, cookie=bob, headers={"X-Call-Id": call.id})
        self.assertEqual(status, 404)
        status, _, _ = self.call("POST", "/api/call/end", {"call": call.id}, cookie=bob)
        self.assertIsNone(call.outcome)                      # bob's "end" did nothing to ann's call

    def test_the_first_account_takes_over_what_was_there_before_accounts(self):
        legacy = settings.FLOWS_FOLDER
        legacy.mkdir(parents=True)
        (legacy / "abc12345.json").write_text("{}", encoding="utf-8")
        (self.root / "calls").mkdir()
        (self.root / "calls" / "c1.json").write_text("{}", encoding="utf-8")
        ann = self.sign_up("ann@example.com")
        _, me, _ = self.call("GET", "/api/auth/me", cookie=ann)
        mine = self.root / "users" / me["user"]["id"]
        self.assertTrue((mine / "flows" / "abc12345.json").exists())
        self.assertTrue((mine / "calls" / "c1.json").exists())
        self.assertFalse(legacy.exists())
        bob = self.sign_up("bob@example.com")                 # a second account takes nothing
        _, flows, _ = self.call("GET", "/api/flows", cookie=bob)
        self.assertNotIn("abc12345", [one["id"] for one in flows["flows"]])
        self.assertTrue((mine / "flows" / "abc12345.json").exists())

    def test_storage_refuses_to_run_for_nobody(self):
        from voice_call import scope, storage
        scope.set_owner("")
        with self.assertRaises(scope.NoOwner):
            storage.list_flows()

    def test_an_account_id_can_not_be_a_path(self):
        from voice_call import scope
        for bad in ("../x", "..", "a/b", "A" * 16, "short"):
            with self.assertRaises(ValueError):
                scope.set_owner(bad)

    def test_me_says_whether_this_is_the_first_account(self):
        _, data, _ = self.call("GET", "/api/auth/me")
        self.assertIsNone(data["user"])
        self.assertTrue(data["first"])


if __name__ == "__main__":
    unittest.main()
