// ═══════════════════════════════════════════════════════════════════════════
// /.netlify/functions/ics: a calendar file for a real conversation coming up.
//   GET ?d=YYYY-MM-DD&t=Interview&w=design lead at a tea brand
// Two events: the day itself (with a reminder at 8pm the evening before to practice),
// and a short check-in the morning after. Nothing is stored.
// ═══════════════════════════════════════════════════════════════════════════
const APP = "https://groundbykian.netlify.app/";
const esc = s => String(s || "").replace(/[\\;,]/g, m => "\\" + m).replace(/\r?\n/g, " ").slice(0, 80);
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");
exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(q.d || "");
  if (!m) return { statusCode: 400, body: "bad date" };
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (isNaN(day)) return { statusCode: 400, body: "bad date" };
  const next = new Date(day.getTime() + 864e5);
  const t = esc(q.t || "Real conversation"), w = esc(q.w || "");
  const title = t + (w ? " · " + w : "");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const uid = ymd(day) + "-" + Math.random().toString(36).slice(2, 10) + "@ground";
  const L = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Ground by Kian How//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT", "UID:a-" + uid, "DTSTAMP:" + stamp,
    "DTSTART;VALUE=DATE:" + ymd(day), "DTEND;VALUE=DATE:" + ymd(next),
    "SUMMARY:" + title, "DESCRIPTION:Practice it in Ground first: " + APP, "URL:" + APP,
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + t + " tomorrow. Run it once in Ground tonight.", "TRIGGER:-PT4H", "END:VALARM",
    "END:VEVENT",
    "BEGIN:VEVENT", "UID:b-" + uid, "DTSTAMP:" + stamp,
    "DTSTART:" + ymd(next) + "T100000", "DTEND:" + ymd(next) + "T101500",
    "SUMMARY:How did it go? Tell K", "DESCRIPTION:One line on how your " + t.toLowerCase() + " went: " + APP, "URL:" + APP,
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:How did it go? Tell K in Ground.", "TRIGGER:PT0M", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR"
  ];
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="ground-' + ymd(day) + '.ics"', "Cache-Control": "no-store" },
    body: L.join("\r\n") + "\r\n"
  };
};
