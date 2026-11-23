//! Standard 5-field cron expressions (`minute hour day-of-month month day-of-week`), evaluated in local time.
//!
//! Supported: `*`, numbers, ranges `a-b`, steps `*/n` and `a-b/n` and `a/n`, lists `a,b,c`, month names (`jan`…`dec`),
//! weekday names (`sun`…`sat`, `7` is Sunday too) and the macros `@yearly` `@annually` `@monthly` `@weekly` `@daily`
//! `@midnight` `@hourly`. As in Vixie cron, when both day-of-month and day-of-week are restricted a day matches when
//! either does.

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike};

#[derive(Clone, Debug, PartialEq)]
pub struct Cron {
    minutes: u64,  // bits 0..=59
    hours: u32,    // bits 0..=23
    days: u32,     // bits 1..=31
    months: u16,   // bits 1..=12
    weekdays: u8,  // bits 0..=6, Sunday = 0
    dom_any: bool, // day-of-month field was `*`
    dow_any: bool,
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

fn parse_value(s: &str, min: u32, max: u32, names: &[&str], name_base: u32) -> Result<u32, String> {
    let lower = s.to_ascii_lowercase();
    if let Some(i) = names.iter().position(|n| *n == lower) {
        return Ok(i as u32 + name_base);
    }
    let v: u32 = s.parse().map_err(|_| format!("giá trị không hợp lệ: \"{s}\""))?;
    if v < min || v > max {
        return Err(format!("{v} nằm ngoài khoảng {min}-{max}"));
    }
    Ok(v)
}

/// Bit set of the values a field selects.
fn parse_field(field: &str, min: u32, max: u32, names: &[&str], name_base: u32) -> Result<(u64, bool), String> {
    if field.is_empty() {
        return Err("thiếu trường".into());
    }
    let mut bits = 0u64;
    let any = field == "*" || field == "?";
    for part in field.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((r, s)) => {
                let step: u32 = s.parse().map_err(|_| format!("bước không hợp lệ: \"{s}\""))?;
                if step == 0 {
                    return Err("bước phải lớn hơn 0".into());
                }
                (r, step)
            }
            None => (part, 1),
        };
        let (lo, hi) = if range == "*" || range == "?" {
            (min, max)
        } else if let Some((a, b)) = range.split_once('-') {
            let a = parse_value(a, min, max, names, name_base)?;
            let b = parse_value(b, min, max, names, name_base)?;
            if a > b {
                return Err(format!("khoảng ngược: {range}"));
            }
            (a, b)
        } else {
            let a = parse_value(range, min, max, names, name_base)?;
            // `a/n` means a, a+n, … up to the maximum.
            (a, if part.contains('/') { max } else { a })
        };
        let mut v = lo;
        while v <= hi {
            bits |= 1 << v;
            v += step;
        }
    }
    Ok((bits, any))
}

impl Cron {
    pub fn parse(expr: &str) -> Result<Self, String> {
        let expr = expr.trim();
        let expanded = match expr.to_ascii_lowercase().as_str() {
            "@yearly" | "@annually" => "0 0 1 1 *".to_owned(),
            "@monthly" => "0 0 1 * *".to_owned(),
            "@weekly" => "0 0 * * 0".to_owned(),
            "@daily" | "@midnight" => "0 0 * * *".to_owned(),
            "@hourly" => "0 * * * *".to_owned(),
            _ => expr.to_owned(),
        };
        let fields: Vec<&str> = expanded.split_whitespace().collect();
        if fields.len() != 5 {
            return Err(format!("cần 5 trường (phút giờ ngày tháng thứ), có {}", fields.len()));
        }
        let (minutes, _) = parse_field(fields[0], 0, 59, &[], 0).map_err(|e| format!("phút: {e}"))?;
        let (hours, _) = parse_field(fields[1], 0, 23, &[], 0).map_err(|e| format!("giờ: {e}"))?;
        let (days, dom_any) = parse_field(fields[2], 1, 31, &[], 0).map_err(|e| format!("ngày: {e}"))?;
        let (months, _) = parse_field(fields[3], 1, 12, &MONTHS, 1).map_err(|e| format!("tháng: {e}"))?;
        let (mut weekdays, dow_any) = parse_field(fields[4], 0, 7, &WEEKDAYS, 0).map_err(|e| format!("thứ: {e}"))?;
        if weekdays & (1 << 7) != 0 {
            weekdays = (weekdays | 1) & 0x7f;
        }
        Ok(Self { minutes, hours: hours as u32, days: days as u32, months: months as u16, weekdays: weekdays as u8, dom_any, dow_any })
    }

    fn day_matches(&self, d: NaiveDate) -> bool {
        if self.months & (1 << d.month()) == 0 {
            return false;
        }
        let dom = self.days & (1 << d.day()) != 0;
        let dow = self.weekdays & (1 << d.weekday().num_days_from_sunday()) != 0;
        match (self.dom_any, self.dow_any) {
            (true, true) => true,
            (true, false) => dow,
            (false, true) => dom,
            (false, false) => dom || dow,
        }
    }

    /// The first matching wall-clock minute strictly after `after` (naive, local wall time).
    pub fn next_naive(&self, after: NaiveDateTime) -> Option<NaiveDateTime> {
        let start = after.with_second(0)?.with_nanosecond(0)? + Duration::minutes(1);
        let mut day = start.date();
        // Five years covers every valid expression (Feb 29 recurs within 8 years only with a weekday OR, which matches sooner).
        for _ in 0..(366 * 8) {
            if self.day_matches(day) {
                let (h0, m0) = if day == start.date() { (start.hour(), start.minute()) } else { (0, 0) };
                for h in h0..24 {
                    if self.hours & (1 << h) == 0 {
                        continue;
                    }
                    let from = if h == h0 { m0 } else { 0 };
                    for m in from..60 {
                        if self.minutes & (1 << m) != 0 {
                            return Some(day.and_time(NaiveTime::from_hms_opt(h, m, 0)?));
                        }
                    }
                }
            }
            day = day.succ_opt()?;
        }
        None
    }

    /// The next fire time after `after` in local time. A wall time skipped by a DST jump is moved past the gap; an
    /// ambiguous one fires once (the earlier instant).
    pub fn next_after(&self, after: DateTime<Local>) -> Option<DateTime<Local>> {
        let mut cursor = after.naive_local();
        for _ in 0..64 {
            let next = self.next_naive(cursor)?;
            match Local.from_local_datetime(&next) {
                chrono::LocalResult::Single(t) => return Some(t),
                chrono::LocalResult::Ambiguous(a, _) => return Some(a),
                chrono::LocalResult::None => cursor = next,
            }
        }
        None
    }
}

/// Human description of the next `count` fire times (for the UI preview).
pub fn upcoming(expr: &str, count: usize) -> Result<Vec<DateTime<Local>>, String> {
    let cron = Cron::parse(expr)?;
    let mut out = Vec::with_capacity(count);
    let mut t = Local::now();
    while out.len() < count {
        match cron.next_after(t) {
            Some(n) => {
                out.push(n);
                t = n;
            }
            None => break,
        }
    }
    if out.is_empty() {
        return Err("biểu thức không bao giờ chạy".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }

    fn next(expr: &str, after: &str) -> String {
        Cron::parse(expr).unwrap().next_naive(at(after)).unwrap().format("%Y-%m-%d %H:%M").to_string()
    }

    #[test]
    fn every_minute_and_step() {
        assert_eq!(next("* * * * *", "2026-01-01 10:00"), "2026-01-01 10:01");
        assert_eq!(next("*/15 * * * *", "2026-01-01 10:01"), "2026-01-01 10:15");
        assert_eq!(next("*/15 * * * *", "2026-01-01 10:45"), "2026-01-01 11:00");
        assert_eq!(next("5/20 * * * *", "2026-01-01 10:26"), "2026-01-01 10:45");
    }

    #[test]
    fn daily_rolls_over_days_months_years() {
        assert_eq!(next("0 9 * * *", "2026-01-01 09:00"), "2026-01-02 09:00");
        assert_eq!(next("30 8 1 * *", "2026-01-31 12:00"), "2026-02-01 08:30");
        assert_eq!(next("@yearly", "2026-06-01 00:00"), "2027-01-01 00:00");
        assert_eq!(next("0 0 29 2 *", "2026-03-01 00:00"), "2028-02-29 00:00");
    }

    #[test]
    fn weekdays_names_and_sunday_seven() {
        // 2026-11-23 is a Monday.
        assert_eq!(next("0 9 * * mon-fri", "2026-11-27 10:00"), "2026-11-30 09:00");
        assert_eq!(next("0 9 * * 7", "2026-11-23 10:00"), "2026-11-29 09:00");
        assert_eq!(next("0 9 * * SUN", "2026-11-23 10:00"), "2026-11-29 09:00");
        assert_eq!(next("0 12 * jan,jul *", "2026-02-01 00:00"), "2026-07-01 12:00");
    }

    #[test]
    fn dom_or_dow_when_both_restricted() {
        // The 1st, or any Friday — whichever comes first. 2026-11-27 is a Friday.
        assert_eq!(next("0 0 1 * fri", "2026-11-23 00:00"), "2026-11-27 00:00");
        assert_eq!(next("0 0 1 * fri", "2026-11-28 00:00"), "2026-12-01 00:00");
    }

    #[test]
    fn rejects_bad_expressions() {
        for bad in ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "*/0 * * * *", "5-1 * * * *", "x * * * *"] {
            assert!(Cron::parse(bad).is_err(), "{bad:?} should fail");
        }
        assert!(Cron::parse("0 0 31 2 *").unwrap().next_naive(at("2026-01-01 00:00")).is_none());
    }
}
