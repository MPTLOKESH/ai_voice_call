/* Which column of a file or a table is which: a first guess from the column names, for a person to correct.
 *
 * A mapping is {name: [columns], phone: column, email: column, extra: [columns]}. Name can be more than one
 * column (first name and last name), joined with a space. Extra columns are kept with each contact as they are.
 */

const PHONE = /phone|mobile|cell|contact.?no|number|whats.?app|msisdn|tel/i;
const EMAIL = /e-?mail/i;
const FULL = /^(full.?name|name|customer.?name|contact.?name|customer|client)$/i;
const FIRST = /first.?name|given.?name|^first$|fname/i;
const LAST = /last.?name|surname|family.?name|^last$|lname/i;

export function guessMapping(columns) {
  const pick = (pattern) => columns.find((column) => pattern.test(column.trim())) || "";
  const phone = pick(PHONE);
  const email = pick(EMAIL);
  const full = pick(FULL);
  const name = full ? [full] : [pick(FIRST), pick(LAST)].filter(Boolean);
  return { name, phone, email, extra: [] };
}

/** The columns the mapping doesn't use: the ones that could be kept as extra details. */
export const unusedColumns = (columns, mapping) =>
  columns.filter((column) => column !== mapping.phone && column !== mapping.email && !mapping.name.includes(column));

/** A row's value in a column, for the samples next to each choice. */
export const cell = (columns, row, column) => {
  const at = columns.indexOf(column);
  return at < 0 ? "" : row[at] ?? "";
};
