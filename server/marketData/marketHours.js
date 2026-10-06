/* Indian market time helpers. Everything is computed in Asia/Kolkata. */
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short'
});

export function ist(ms = Date.now()) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}`, minutes: +p.hour * 60 + +p.minute, weekday: p.weekday };
}
export const istDate = ms => ist(ms).date;

/* Regular equity session: Monday to Friday, 09:15 to 15:30 IST.
   Exchange holidays are not hard-coded: the service detects them from the
   provider's own segment status and from the date on the data it receives. */
export const SESSION = { open: 9 * 60 + 15, close: 15 * 60 + 30 };
export function inScheduledSession(ms = Date.now()) {
  const t = ist(ms);
  return t.weekday !== 'Sat' && t.weekday !== 'Sun' && t.minutes >= SESSION.open && t.minutes < SESSION.close;
}
export function shiftDate(dateStr, days) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}
/* 15:30 IST on a given IST date, as epoch ms. */
export const sessionCloseMs = dateStr => Date.parse(dateStr + 'T15:30:00+05:30');
