"""Keys, usage, allowance, email links, the account routes and the hardening around them.

Run with:  python -m unittest discover tests
No network and no real keys: the one check a provider would make is replaced, and every file goes to a temp folder.
"""
import json
import tempfile
import unittest
from http.client import HTTPConnection
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from pydantic import BaseModel

from test_accounts import PASSWORD, Fresh, Served
from voice_call import accounts, credentials, gemini, mailer, scope, server, settings, usage, vault
from voice_call.models import BusinessSetup, Question

KEY = "AIzaSyTESTKEY-1234567890abcdef"
OTHER_KEY = "sk_live_0123456789abcdefABCDEF"


def person(email="a@example.com", **more):
    made, _ = accounts.sign_up(email, PASSWORD, **more)
    return made["id"]


class Vault(Fresh):
    def test_round_trip_and_not_plain(self):
        sealed = vault.seal(KEY, "ctx")
        self.assertNotIn(KEY, sealed)
        self.assertEqual(vault.unseal(sealed, "ctx"), KEY)
        self.assertNotEqual(vault.seal(KEY, "ctx"), sealed)                # a fresh nonce each time

    def test_bound_to_what_it_belongs_to(self):
        sealed = vault.seal(KEY, "api-key:alice:gemini")
        with self.assertRaises(vault.Unreadable):
            vault.unseal(sealed, "api-key:bob:gemini")

    def test_tampering_is_caught(self):
        sealed = vault.seal(KEY, "ctx")
        broken = sealed[:-4] + ("AAAA" if not sealed.endswith("AAAA") else "BBBB")
        with self.assertRaises(vault.Unreadable):
            vault.unseal(broken, "ctx")


class Keys(Fresh):
    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(credentials, "check", return_value="")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.alice, self.bob = person("alice@example.com"), person("bob@example.com")

    def test_an_own_key_is_stored_encrypted_and_only_its_end_is_shown(self):
        credentials.save(self.alice, "gemini", KEY)
        self.assertNotIn(KEY.encode(), accounts.DB_FILE.read_bytes())
        shown = credentials.status(self.alice)["gemini"]
        self.assertEqual((shown["last4"], shown["mode"]), (KEY[-4:], "own"))
        self.assertNotIn(KEY, json.dumps(credentials.status(self.alice)))

    def test_it_pays_for_that_person_only(self):
        credentials.save(self.alice, "gemini", KEY)
        with scope.acting_as(self.alice):
            self.assertEqual(credentials.resolve("gemini"), (KEY, "own"))
        with scope.acting_as(self.bob), mock.patch.dict("os.environ", {"GEMINI_API_KEY": ""}):
            with self.assertRaises(credentials.Blocked):
                credentials.resolve("gemini")

    def test_a_copied_ciphertext_does_not_work_in_another_row(self):
        credentials.save(self.alice, "gemini", KEY)
        with accounts._db() as db:
            sealed = db.execute("SELECT sealed FROM api_keys WHERE user_id = ?", (self.alice,)).fetchone()[0]
            db.execute("INSERT INTO api_keys (user_id, service, sealed, last4, active, created) VALUES (?, 'gemini', ?, 'x', 1, '')",
                       (self.bob, sealed))
        with scope.acting_as(self.bob), self.assertRaises(credentials.Blocked):
            credentials.resolve("gemini")

    def test_switching_back_to_ours_and_removing(self):
        credentials.save(self.alice, "gemini", KEY)
        with mock.patch.dict("os.environ", {"GEMINI_API_KEY": OTHER_KEY}), scope.acting_as(self.alice):
            credentials.set_mode(self.alice, "gemini", "ours")
            self.assertEqual(credentials.resolve("gemini"), (OTHER_KEY, "ours"))
            credentials.set_mode(self.alice, "gemini", "own")
            self.assertEqual(credentials.resolve("gemini")[1], "own")
            credentials.remove(self.alice, "gemini")
            self.assertEqual(credentials.resolve("gemini")[1], "ours")
        with self.assertRaises(credentials.Blocked):
            credentials.set_mode(self.alice, "gemini", "own")                # nothing saved to switch to

    def test_junk_is_not_saved_and_a_key_the_provider_refuses_is_not_kept(self):
        for junk in ("", "short", "has space in it 1234567890", "line\nbreak1234567890123456", "x" * 300):
            with self.assertRaises(credentials.Blocked):
                credentials.save(self.alice, "gemini", junk)
        with mock.patch.object(credentials, "check", side_effect=credentials.Blocked("no", 400)):
            with self.assertRaises(credentials.Blocked):
                credentials.save(self.alice, "gemini", KEY)
        self.assertFalse(credentials.status(self.alice)["gemini"]["has_own"])

    def test_allowance_is_checked_on_our_key_and_not_on_theirs(self):
        with mock.patch.dict("os.environ", {"GEMINI_API_KEY": OTHER_KEY}), scope.acting_as(self.alice):
            credentials.resolve("gemini")                                    # fine to begin with
            usage.record("gemini", "ours", 10_000_000, 10_000_000)           # about $5 of the $1 allowance
            with self.assertRaises(credentials.Blocked) as stopped:
                credentials.resolve("gemini")
            self.assertIn("allowance", str(stopped.exception))
            credentials.save(self.alice, "gemini", KEY)                      # their own key is not counted
            self.assertEqual(credentials.resolve("gemini")[1], "own")

    def test_a_bigger_allowance_for_one_account(self):
        accounts.administer(self.alice, allowance=100.0)
        with mock.patch.dict("os.environ", {"GEMINI_API_KEY": OTHER_KEY}), scope.acting_as(self.alice):
            usage.record("gemini", "ours", 10_000_000, 10_000_000)
            self.assertEqual(credentials.resolve("gemini")[1], "ours")

    def test_our_key_needs_a_confirmed_email_when_mail_can_be_sent(self):
        with mock.patch.object(mailer, "configured", return_value=True), mock.patch.object(mailer, "send"):
            fresh = person("carol@example.com")                              # not the first account: not confirmed
        with mock.patch.dict("os.environ", {"GEMINI_API_KEY": OTHER_KEY}), scope.acting_as(fresh):
            with self.assertRaises(credentials.Blocked) as stopped:
                credentials.resolve("gemini")
            self.assertEqual(stopped.exception.status, 403)

    def test_a_failing_own_key_never_falls_back_to_ours(self):
        from google.genai import errors
        calls = []

        def refuses(model):
            calls.append(model)
            raise errors.APIError(401, {"error": {"message": "bad key", "status": "UNAUTHENTICATED"}})
        with self.assertRaises(credentials.Blocked):
            gemini.call_gemini(refuses, source="own")
        self.assertEqual(len(calls), 1)                                      # tried once, no retries, no other key


class Ledger(Fresh):
    def setUp(self):
        super().setUp()
        self.alice, self.bob = person("alice@example.com"), person("bob@example.com")

    def test_what_gemini_reports_is_written_down(self):
        class Out(BaseModel):
            ok: bool
        reply = SimpleNamespace(text='{"ok": true}', model_version="m1", usage_metadata=SimpleNamespace(
            prompt_token_count=1000, candidates_token_count=200, thoughts_token_count=50))
        fake = SimpleNamespace(models=SimpleNamespace(generate_content=lambda **_: reply))
        with mock.patch.dict("os.environ", {"GEMINI_API_KEY": OTHER_KEY}), mock.patch.object(gemini, "client", return_value=fake), \
                scope.acting_as(self.alice), usage.tagged("studio", "f1"):
            self.assertTrue(gemini.ask_ai(Out, "hi").ok)
        mine = usage.summary(self.alice)
        self.assertEqual(mine["totals"]["requests"], 1)
        self.assertEqual(mine["totals"]["tokens"], 1250)
        self.assertEqual(mine["by_kind"][0]["key"], "studio")
        self.assertEqual(mine["by_flow"][0]["key"], "f1")
        self.assertEqual(mine["recent"][0]["source"], "ours")
        self.assertAlmostEqual(mine["totals"]["ours"], (1000 * 0.10 + 250 * 0.40) / 1e6, places=7)

    def test_each_person_sees_only_their_own(self):
        with scope.acting_as(self.alice):
            usage.record("speak", "own", 500)
        self.assertEqual(usage.summary(self.alice)["totals"]["characters"], 500)
        self.assertEqual(usage.summary(self.bob)["totals"]["requests"], 0)
        self.assertEqual(usage.month_totals().get(self.alice, 0), 0)        # their own key is not counted against ours

    def test_the_plan_says_what_is_left(self):
        with scope.acting_as(self.alice):
            usage.record("hear", "ours", 3600)                                # an hour of listening: $0.40
        plan = usage.plan(accounts.get(self.alice))
        self.assertAlmostEqual(plan["used"], 0.40)
        self.assertAlmostEqual(plan["left"], settings.FREE_ALLOWANCE_USD - 0.40)

    def test_recording_never_breaks_a_request(self):
        with mock.patch.object(accounts, "_db", side_effect=RuntimeError("disk full")), scope.acting_as(self.alice):
            usage.record("speak", "ours", 10)                                # prints a note, raises nothing


class Links(Fresh):
    def setUp(self):
        super().setUp()
        self.sent = []
        for patcher in (mock.patch.object(mailer, "configured", return_value=True),
                        mock.patch.object(mailer, "send", side_effect=lambda to, subject, body: self.sent.append((to, subject, body)))):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.first = person("owner@example.com")

    def token(self):
        return self.sent[-1][2].split("token=")[1].split()[0]

    def test_confirming_an_email_works_once(self):
        carol = person("carol@example.com")
        self.assertFalse(accounts.get(carol)["verified"])
        accounts.verify_email(self.token())
        self.assertTrue(accounts.get(carol)["verified"])
        with self.assertRaises(accounts.Problem):
            accounts.verify_email(self.token())

    def test_a_reset_works_once_and_signs_everyone_out(self):
        _, session = accounts.sign_in("owner@example.com", PASSWORD)
        accounts.request_reset("owner@example.com")
        link = self.token()
        accounts.reset_password(link, "a brand new password")
        self.assertIsNone(accounts.user_for(session))
        accounts.sign_in("owner@example.com", "a brand new password")
        with self.assertRaises(accounts.Problem):
            accounts.reset_password(link, "another one again")
        with self.assertRaises(accounts.Problem):
            accounts.sign_in("owner@example.com", PASSWORD)

    def test_asking_for_a_reset_does_not_reveal_who_has_an_account(self):
        before = len(self.sent)
        accounts.request_reset("nobody@example.com")                          # no error, and no mail
        self.assertEqual(len(self.sent), before)

    def test_a_newer_link_replaces_the_older(self):
        accounts.request_reset("owner@example.com")
        older = self.token()
        accounts.request_reset("owner@example.com")
        with self.assertRaises(accounts.Problem):
            accounts.reset_password(older, "a brand new password")

    def test_changing_a_password_needs_the_old_one_and_signs_other_devices_out(self):
        _, here = accounts.sign_in("owner@example.com", PASSWORD)
        _, elsewhere = accounts.sign_in("owner@example.com", PASSWORD)
        with self.assertRaises(accounts.Problem):
            accounts.change_password(self.first, "wrong password!", "a brand new password", here)
        accounts.change_password(self.first, PASSWORD, "a brand new password", keep_token=here)
        self.assertIsNotNone(accounts.user_for(here))
        self.assertIsNone(accounts.user_for(elsewhere))

    def test_deleting_an_account_takes_everything(self):
        with mock.patch.object(credentials, "check", return_value=""):
            credentials.save(self.first, "gemini", KEY)
        with scope.acting_as(self.first):
            usage.record("speak", "ours", 10)
        _, session = accounts.sign_in("owner@example.com", PASSWORD)
        accounts.delete_account(self.first)
        self.assertIsNone(accounts.get(self.first))
        self.assertIsNone(accounts.user_for(session))
        with accounts._db() as db:
            for table in ("api_keys", "usage", "audit", "sessions"):
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {table} WHERE user_id = ?", (self.first,)).fetchone()[0], 0, table)

    def test_the_account_keeps_its_own_history(self):
        accounts.sign_in("owner@example.com", PASSWORD, address="9.9.9.9")
        events = [one["event"] for one in accounts.history(self.first)]
        self.assertIn("Signed in", events)
        self.assertIn("Account made", events)


class Routes(Served):
    def setUp(self):
        super().setUp()
        for patcher in (mock.patch.object(credentials, "check", return_value=""),
                        mock.patch.dict("os.environ", {"GEMINI_API_KEY": "", "ELEVENLABS_API_KEY": ""})):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.owner = self.sign_up("owner@example.com")          # the first account runs the server
        self.guest = self.sign_up("guest@example.com")

    def test_the_account_page_gets_the_plan_and_keys_but_never_a_key(self):
        self.call("POST", "/api/account/keys", {"service": "gemini", "key": KEY}, cookie=self.guest)
        status, data, _ = self.call("GET", "/api/account", cookie=self.guest)
        self.assertEqual(status, 200)
        self.assertEqual(data["keys"]["gemini"]["last4"], KEY[-4:])
        self.assertEqual(data["keys"]["gemini"]["mode"], "own")
        self.assertIn("allowance", data["plan"])
        for path in ("/api/account", "/api/account/activity", "/api/account/usage"):
            self.assertNotIn(KEY, json.dumps(self.call("GET", path, cookie=self.guest)[1]))

    def test_saving_a_key_does_not_echo_it_back(self):
        status, data, _ = self.call("POST", "/api/account/keys", {"service": "elevenlabs", "key": OTHER_KEY}, cookie=self.guest)
        self.assertEqual(status, 200)
        self.assertNotIn(OTHER_KEY, json.dumps(data))
        status, data, _ = self.call("POST", "/api/account/keys", {"service": "gemini", "key": "nope"}, cookie=self.guest)
        self.assertEqual(status, 400)

    def test_only_the_person_running_the_server_can_administer(self):
        self.assertEqual(self.call("GET", "/api/admin/users", cookie=self.guest)[0], 403)
        self.assertEqual(self.call("POST", f"/api/admin/users/{self.user_id(self.guest)}", {"allowance": 99}, cookie=self.guest)[0], 403)
        status, data, _ = self.call("GET", "/api/admin/users", cookie=self.owner)
        self.assertEqual(status, 200)
        self.assertEqual(len(data["users"]), 2)

    def test_the_administrator_can_change_an_allowance_and_turn_an_account_off(self):
        guest_id = self.user_id(self.guest)
        self.call("POST", f"/api/admin/users/{guest_id}", {"allowance": 7.5}, cookie=self.owner)
        self.assertEqual(self.call("GET", "/api/account", cookie=self.guest)[1]["plan"]["allowance"], 7.5)
        self.call("POST", f"/api/admin/users/{guest_id}", {"disabled": True}, cookie=self.owner)
        self.assertEqual(self.call("GET", "/api/flows", cookie=self.guest)[0], 401)       # their session ended at once
        self.assertEqual(self.call("POST", "/api/auth/signin", {"email": "guest@example.com", "password": PASSWORD})[0], 403)
        self.assertEqual(self.call("POST", f"/api/admin/users/{self.user_id(self.owner)}", {"disabled": True}, cookie=self.owner)[0], 400)

    def test_a_call_is_not_started_that_cannot_be_paid_for(self):
        body = {"setup": BusinessSetup(purpose="Check a booking", questions=[Question(save_as="n", ask="How many?")]).model_dump(),
                "speak": False}
        status, data, _ = self.call("POST", "/api/call/start", body, cookie=self.guest)      # no key of ours, none of theirs
        self.assertEqual(status, 402)
        self.assertTrue(data["blocked"])

    def test_every_response_carries_the_security_headers(self):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=10)
        for path in ("/", "/api/auth/me", "/account"):
            connection.request("GET", path)
            reply = connection.getresponse()
            reply.read()
            self.assertIn("default-src 'self'", reply.getheader("Content-Security-Policy"), path)
            self.assertEqual(reply.getheader("X-Content-Type-Options"), "nosniff", path)
            self.assertEqual(reply.getheader("X-Frame-Options"), "DENY", path)
        connection.close()

    def test_a_connection_that_stays_open_does_not_keep_a_session_that_ended(self):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Cookie": self.guest, "Content-Type": "application/json"}
        connection.request("GET", "/api/flows", headers=headers)
        first = connection.getresponse()
        first.read()
        self.assertEqual(first.status, 200)
        accounts.sign_out(self.guest.split("=", 1)[1])
        connection.request("GET", "/api/flows", headers=headers)                          # the same connection
        second = connection.getresponse()
        second.read()
        self.assertEqual(second.status, 401)
        connection.close()

    def test_a_request_too_big_is_refused(self):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.putrequest("POST", "/api/flows")
        for name, value in (("Cookie", self.guest), ("Content-Type", "application/json"),
                            ("Content-Length", str(server.MAX_JSON + 1))):
            connection.putheader(name, value)
        connection.endheaders()
        self.assertEqual(connection.getresponse().status, 413)
        connection.close()

    def test_deleting_the_account_needs_the_password_and_removes_the_folder(self):
        guest_id = self.user_id(self.guest)
        self.call("POST", "/api/flows", {"name": "mine"}, cookie=self.guest)
        folder = self.root / "users" / guest_id
        self.assertTrue(folder.exists())
        self.assertEqual(self.call("POST", "/api/account/delete", {"password": "wrong password!!"}, cookie=self.guest)[0], 403)
        self.assertTrue(folder.exists())
        self.assertEqual(self.call("POST", "/api/account/delete", {"password": PASSWORD}, cookie=self.guest)[0], 200)
        self.assertFalse(folder.exists())
        self.assertEqual(self.call("GET", "/api/flows", cookie=self.guest)[0], 401)
        self.assertEqual(self.call("POST", "/api/auth/signin", {"email": "guest@example.com", "password": PASSWORD})[0], 401)

    def test_a_guest_cannot_reach_the_servers_files_or_network_through_a_database_connection(self):
        for kind, address in (("sqlite", str(accounts.DB_FILE)), ("postgres", "postgresql://u:p@127.0.0.1:5432/x"),
                              ("mysql", "mysql://u:p@localhost/x"), ("postgres", "host=10.0.0.5 dbname=x")):
            status, data, _ = self.call("POST", "/api/contacts/connections", {"name": "x", "kind": kind, "address": address},
                                        cookie=self.guest)
            self.assertEqual(status, 400, (kind, address))

    def test_even_the_administrator_cannot_read_the_apps_own_data_as_a_database(self):
        status, data, _ = self.call("POST", "/api/contacts/connections",
                                    {"name": "x", "kind": "sqlite", "address": str(accounts.DB_FILE)}, cookie=self.owner)
        self.assertEqual(status, 400)
        self.assertIn("own data", data["error"])

    def test_saved_database_passwords_are_encrypted_on_disk(self):
        with tempfile.TemporaryDirectory() as elsewhere:
            database = Path(elsewhere) / "shop.db"
            import sqlite3
            sqlite3.connect(database).executescript("CREATE TABLE t (a); INSERT INTO t VALUES (1);").close() if False else None
            connection = sqlite3.connect(database)
            connection.executescript("CREATE TABLE t (a); INSERT INTO t VALUES (1);")
            connection.close()
            status, data, _ = self.call("POST", "/api/contacts/connections",
                                        {"name": "shop", "kind": "sqlite", "address": str(database)}, cookie=self.owner)
            self.assertEqual(status, 200, data)
            stored = (self.root / "users" / self.user_id(self.owner) / "connections.json").read_text()
            self.assertNotIn(str(database), stored)
            self.assertIn("v1:", stored)
            listed = self.call("GET", "/api/contacts/sources", cookie=self.owner)[1]["connections"]
            self.assertEqual(len(listed), 1)


class Signing(Served):
    """Public routes that need no session: confirm, forgot, reset."""

    def test_asking_for_a_reset_always_looks_the_same(self):
        self.sign_up("owner@example.com")
        a = self.call("POST", "/api/auth/forgot", {"email": "owner@example.com"})
        b = self.call("POST", "/api/auth/forgot", {"email": "nobody@example.com"})
        self.assertEqual((a[0], a[1]), (b[0], b[1]))

    def test_a_bad_link_is_refused(self):
        self.assertEqual(self.call("POST", "/api/auth/verify", {"token": "nonsense"})[0], 400)
        self.assertEqual(self.call("POST", "/api/auth/reset", {"token": "nonsense", "password": "a brand new password"})[0], 400)


if __name__ == "__main__":
    unittest.main()
