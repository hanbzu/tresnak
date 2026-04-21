#!/usr/bin/env -S deno run --allow-run --allow-env

/**
 * Generates an ASCII candlestick chart of cumulative lines of code, one candle per week.
 *
 * Each candle shows whether there was activity that week, how much was added (wick above body),
 * how much was deleted (wick below body), and the net consolidation (body height and direction).
 *
 * The chart also tracks codebase growth over time. Growth has a cost — more code means more to
 * read, maintain, and understand — so the goal is deliberate expansion, not mindless accumulation.
 *
 * Parameters:
 * - `--months N` / `-m N` controls how far back the chart goes. Default: 6 months.
 * - `--lines-per-block N` / `-b N` controls the vertical scale. Default: 500 LOC per row.
 * - Y axis labels and guide lines are emitted every 4 blocks automatically.
 * - The historical positional `[weeks]` argument is still accepted for backwards compatibility.
 */

const DEFAULT_LINES_PER_BLOCK = 500; // vertical resolution: one character row equals this many lines
const Y_AXIS_INTERVAL_MULTIPLIER = 4; // Y axis labels appear every 4 block heights
const WEEKS_PER_MONTH = 4.33; // approximation used to convert a week count to months for display
const DEFAULT_MONTHS = 6;
const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
];

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const useColor =
    !Deno.env.get("NO_COLOR") &&
    (Deno.stdout.isTerminal() ||
        !!Deno.env.get("FORCE_COLOR") ||
        Deno.env.get("CI") === "true");

interface CliOptions {
    months: number;
    weeks: number;
    linesPerBlock: number;
    rangeLabel: string;
}

/** Parses CLI flags while preserving the historical positional week-count argument. */
function parseArgs(args: string[]): CliOptions {
    let months = DEFAULT_MONTHS;
    let weeksOverride: number | null = null;
    let linesPerBlock = DEFAULT_LINES_PER_BLOCK;
    let positionalWeeksConsumed = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (!arg.startsWith("-") && !positionalWeeksConsumed) {
            weeksOverride = parsePositiveInt(arg, "weeks");
            positionalWeeksConsumed = true;
            continue;
        }

        if (arg === "--months" || arg === "-m") {
            months = parsePositiveInt(args[++i], "months");
            continue;
        }

        if (arg.startsWith("--months=")) {
            months = parsePositiveInt(arg.slice("--months=".length), "months");
            continue;
        }

        if (arg === "--lines-per-block" || arg === "-b") {
            linesPerBlock = parsePositiveInt(args[++i], "lines-per-block");
            continue;
        }

        if (arg.startsWith("--lines-per-block=")) {
            linesPerBlock = parsePositiveInt(
                arg.slice("--lines-per-block=".length),
                "lines-per-block",
            );
            continue;
        }

        if (arg === "--help" || arg === "-h") {
            console.log(
                [
                    "Usage: codecandles.ts [weeks] [--months N] [--lines-per-block N]",
                    "",
                    `Defaults: --months ${DEFAULT_MONTHS}, --lines-per-block ${DEFAULT_LINES_PER_BLOCK}`,
                    "The optional positional [weeks] argument is kept for backwards compatibility.",
                ].join("\n"),
            );
            Deno.exit(0);
        }

        console.error(`Unknown argument: ${arg}`);
        Deno.exit(1);
    }

    const weeks = weeksOverride ??
        Math.max(1, Math.round(months * WEEKS_PER_MONTH));
    const rangeLabel = weeksOverride !== null
        ? `last ${weeks} week${weeks === 1 ? "" : "s"}`
        : `last ${months} month${months === 1 ? "" : "s"}`;

    return { months, weeks, linesPerBlock, rangeLabel };
}

function parsePositiveInt(value: string | undefined, name: string): number {
    const normalized = value?.trim() ?? "";
    if (!/^[1-9]\d*$/.test(normalized)) {
        console.error(`${name} must be a positive integer.`);
        Deno.exit(1);
    }
    return Number(normalized);
}

const options = parseArgs(Deno.args);
const labelInterval = options.linesPerBlock * Y_AXIS_INTERVAL_MULTIPLIER;

/** Wraps text in an ANSI escape code when color output is enabled. */
function styled(text: string, code: string): string {
    return useColor ? `${code}${text}${RESET}` : text;
}

/** Formats a line count in k notation (e.g. 1500 → "1.5k", 2000 → "2k"). */
function fmtK(n: number): string {
    const k = n / 1000;
    // toFixed(1) can produce "15.0" when rounding, so strip the trailing .0
    return (
        (Number.isInteger(k)
            ? k.toString()
            : k.toFixed(1).replace(/\.0$/, "")) + "k"
    );
}

interface Week {
    date: string; // ISO Monday, e.g. "2024-10-07"
    adds: number;
    dels: number;
}

interface Commit {
    date: string; // ISO Monday, e.g. "2024-10-07"
    adds: number;
    dels: number;
}

interface Candle {
    date: string;
    open: number;
    close: number;
    high: number;
    low: number;
}

/** Returns the ISO Monday (YYYY-MM-DD) for the week containing the given date. */
function isoMonday(dateStr: string): string {
    const d = new Date(dateStr + "T00:00:00Z");
    const day = d.getUTCDay();
    // Sunday (0) steps back 6 days; all other days step back to Monday
    d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
    return d.toISOString().slice(0, 10);
}

/** Returns the ISO Monday for the week that was n weeks ago. */
function mondayNWeeksAgo(n: number): string {
    const d = new Date();
    const day = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day) - n * 7);
    return d.toISOString().slice(0, 10);
}

/** Returns commit-level additions and deletions in chronological order. */
async function fetchCommits(): Promise<Commit[]> {
    const { stdout, success } = await new Deno.Command("git", {
        args: [
            "log",
            "--reverse",
            "--pretty=format:%cd",
            "--date=short",
            "--numstat",
        ],
        stdout: "piped",
        stderr: "null",
    }).output();

    if (!success) {
        console.error(
            "git log failed – make sure you are inside a git repository.",
        );
        Deno.exit(1);
    }

    const commits: Commit[] = [];
    let currentCommit: Commit | null = null;

    for (const line of new TextDecoder().decode(stdout).split("\n")) {
        const trimmed = line.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
            if (currentCommit) {
                commits.push(currentCommit);
            }
            currentCommit = {
                date: isoMonday(trimmed),
                adds: 0,
                dels: 0,
            };
        } else if (currentCommit) {
            const m = trimmed.match(/^(\d+)\t(\d+)\t/);
            if (m) {
                currentCommit.adds += parseInt(m[1]);
                currentCommit.dels += parseInt(m[2]);
            }
        }
    }

    if (currentCommit) {
        commits.push(currentCommit);
    }

    return commits;
}

/** Aggregates commit-level stats into weekly totals. */
function aggregateWeeklyStats(commits: Commit[]): Week[] {
    const byWeek = new Map<string, { adds: number; dels: number }>();

    for (const commit of commits) {
        const week = byWeek.get(commit.date) ?? { adds: 0, dels: 0 };
        week.adds += commit.adds;
        week.dels += commit.dels;
        byWeek.set(commit.date, week);
    }

    return [...byWeek.entries()].map(([date, { adds, dels }]) => ({
        date,
        adds,
        dels,
    }));
}

/** Returns a dense array covering the last n weeks, with zeros for weeks with no commits. */
function fillWindow(data: Week[], n: number): Week[] {
    const byWeek = new Map(data.map((w) => [w.date, w]));
    return Array.from({ length: n }, (_, i) => {
        const date = mondayNWeeksAgo(n - 1 - i);
        return byWeek.get(date) ?? { date, adds: 0, dels: 0 };
    });
}

/** Converts commit-level stats into weekly OHLC candles using the actual weekly LOC path. */
function buildCandles(commits: Commit[], weeksToRender: number): Candle[] {
    const startWeek = mondayNWeeksAgo(weeksToRender - 1);
    const startIndex = commits.findIndex((commit) => commit.date >= startWeek);
    const windowStartIndex = startIndex === -1 ? commits.length : startIndex;

    let loc = 0;
    for (let i = 0; i < windowStartIndex; i++) {
        loc += commits[i].adds - commits[i].dels;
    }

    const commitsByWeek = new Map<string, Commit[]>();
    for (let i = windowStartIndex; i < commits.length; i++) {
        const commit = commits[i];
        const bucket = commitsByWeek.get(commit.date) ?? [];
        bucket.push(commit);
        commitsByWeek.set(commit.date, bucket);
    }

    return Array.from({ length: weeksToRender }, (_, i) => {
        const date = mondayNWeeksAgo(weeksToRender - 1 - i);
        const weekCommits = commitsByWeek.get(date) ?? [];
        const open = loc;
        let high = open;
        let low = open;

        for (const commit of weekCommits) {
            loc += commit.adds - commit.dels;
            high = Math.max(high, loc);
            low = Math.min(low, loc);
        }

        return { date, open, close: loc, high, low };
    });
}

interface XAxisLabels {
    months: string;
    years: string;
}

/** Builds the X axis labels, placing month names at month-start weeks and years under January. */
function buildXAxisLabels(candles: Candle[]): XAxisLabels {
    const monthCells = new Array<string>(candles.length).fill(" ");
    const yearCells = new Array<string>(candles.length).fill(" ");

    for (let i = 0; i < candles.length; i++) {
        const monday = new Date(candles[i].date + "T00:00:00Z");
        // Scan all 7 days of the week to find if the 1st of a month falls within it
        for (let d = 0; d < 7; d++) {
            const day = new Date(monday);
            day.setUTCDate(monday.getUTCDate() + d);
            if (day.getUTCDate() === 1) {
                const monthLabel = MONTHS[day.getUTCMonth()];
                for (
                    let j = 0;
                    j < monthLabel.length && i + j < monthCells.length;
                    j++
                ) {
                    monthCells[i + j] = monthLabel[j];
                }

                if (monthLabel === "Jan") {
                    const yearLabel = String(day.getUTCFullYear());
                    for (
                        let j = 0;
                        j < yearLabel.length && i + j < yearCells.length;
                        j++
                    ) {
                        yearCells[i + j] = yearLabel[j];
                    }
                }
                break;
            }
        }
    }

    return {
        months: monthCells.join(""),
        years: yearCells.join(""),
    };
}

/** Renders the full candlestick chart to stdout. */
function render(
    candles: Candle[],
    totalAdds: number,
    totalDels: number,
    rangeLabel: string,
    linesPerBlock: number,
    yAxisInterval: number,
): void {
    if (candles.length === 0) {
        console.log("No git history found.");
        return;
    }

    const high =
        Math.ceil(Math.max(...candles.map((c) => c.high)) / yAxisInterval) *
        yAxisInterval;
    const low =
        Math.floor(Math.min(...candles.map((c) => c.low)) / yAxisInterval) *
        yAxisInterval;
    const chartHeight = Math.max(1, (high - low) / linesPerBlock);
    const labelWidth = Math.max(fmtK(high).length, fmtK(low).length) + 1;

    console.log(styled(`Lines of code weekly · ${rangeLabel}`, BOLD));
    console.log();

    for (let row = 0; row < chartHeight; row++) {
        // Sample the vertical midpoint of each row to determine which part of the candle is visible
        const y = high - (row + 0.5) * linesPerBlock;
        const rowLoc = Math.round(high - row * linesPerBlock);
        const isLabelRow = rowLoc % yAxisInterval === 0;
        const label = isLabelRow
            ? fmtK(rowLoc).padStart(labelWidth)
            : " ".repeat(labelWidth);
        let line = styled(label, DIM) + " ";

        for (const candle of candles) {
            const bodyTop = Math.max(candle.open, candle.close);
            const bodyBottom = Math.min(candle.open, candle.close);
            const color = candle.close >= candle.open ? GREEN : RED;

            if (y >= bodyBottom && y <= bodyTop) {
                line += styled("█", color);
            } else if (
                (y > bodyTop && y <= candle.high) ||
                (y >= candle.low && y < bodyBottom)
            ) {
                line += "│";
            } else {
                line += isLabelRow ? styled("·", DIM) : " ";
            }
        }
        console.log(line);
    }

    const xAxisLabels = buildXAxisLabels(candles);

    console.log();
    console.log(styled(" ".repeat(labelWidth + 1) + xAxisLabels.months, DIM));
    console.log(styled(" ".repeat(labelWidth + 1) + xAxisLabels.years, DIM));

    const currentLoc = candles.at(-1)!.close;
    console.log();
    console.log(
        `Currently ${styled(fmtK(currentLoc) + " lines", BOLD)} ` +
            `(${styled("+" + fmtK(totalAdds), GREEN)} ${styled("-" + fmtK(totalDels), RED)} over the ${rangeLabel})`,
    );
}

// ── Main ──────────────────────────────────────────────────────────────────────

const allCommits = await fetchCommits();
const allData = aggregateWeeklyStats(allCommits);
const windowData = fillWindow(allData, options.weeks);
const windowCandles = buildCandles(allCommits, options.weeks);
const totalAdds = windowData.reduce((s, w) => s + w.adds, 0);
const totalDels = windowData.reduce((s, w) => s + w.dels, 0);
render(
    windowCandles,
    totalAdds,
    totalDels,
    options.rangeLabel,
    options.linesPerBlock,
    labelInterval,
);
