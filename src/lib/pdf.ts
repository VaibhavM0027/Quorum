import PDFDocument from "pdfkit";
import type { DiscussionReport, ReportParticipant } from "./reports";
import { orderedDimensions, needsMoreEvidence } from "./reports";
import { scoreBand } from "./rubric";

/**
 * PDF rendering for discussion reports.
 *
 * Everything is drawn from the same `DiscussionReport` object the HTML page
 * uses, so a downloaded PDF always matches what the reader saw on screen.
 * PDFKit's standard fonts are used, so no font files need to ship.
 */

const PAGE = { size: "A4" as const, margin: 48 };

/** Width of the printable area, used to lay columns out. */
const CONTENT_WIDTH = 595.28 - PAGE.margin * 2;

const COLOR = {
  text: "#16241d",
  muted: "#5f7369",
  faint: "#8ea196",
  accent: "#0f9d70",
  warn: "#b45309",
  danger: "#b91c1c",
  line: "#dde5e0",
  panel: "#f4f7f5",
};

type Cell = {
  text: string;
  x: number;
  width: number;
  align?: "left" | "right";
  bold?: boolean;
  color?: string;
};

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function formatDate(value: Date | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

function scoreColor(score: number | null): string {
  if (score === null) return COLOR.muted;
  const tone = scoreBand(score).tone;
  return tone === "good" ? COLOR.accent : tone === "ok" ? COLOR.warn : COLOR.danger;
}

/** Starts a new page when the next block would not fit. */
function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
  const limit = doc.page.height - doc.page.margins.bottom - 24;
  if (doc.y + needed > limit) doc.addPage();
}

function heading(doc: PDFKit.PDFDocument, text: string): void {
  ensureSpace(doc, 40);
  doc.moveDown(0.6);
  doc.fillColor(COLOR.accent).font("Helvetica-Bold").fontSize(11).text(text.toUpperCase(), {
    characterSpacing: 0.6,
  });
  doc.moveTo(PAGE.margin, doc.y + 3)
    .lineTo(PAGE.margin + CONTENT_WIDTH, doc.y + 3)
    .lineWidth(0.7)
    .strokeColor(COLOR.line)
    .stroke();
  doc.moveDown(0.7);
  doc.fillColor(COLOR.text).font("Helvetica").fontSize(10);
}

function paragraph(doc: PDFKit.PDFDocument, text: string, options: { muted?: boolean } = {}): void {
  doc.fillColor(options.muted ? COLOR.muted : COLOR.text).font("Helvetica").fontSize(10);
  doc.text(text, { width: CONTENT_WIDTH, align: "left" });
}

function bulletList(doc: PDFKit.PDFDocument, items: string[]): void {
  if (items.length === 0) {
    paragraph(doc, "None recorded.", { muted: true });
    return;
  }
  doc.font("Helvetica").fontSize(10).fillColor(COLOR.text);
  for (const item of items) {
    ensureSpace(doc, 26);
    const startY = doc.y;
    doc.fillColor(COLOR.accent).text("•", PAGE.margin, startY, { width: 12 });
    doc.fillColor(COLOR.text).text(item, PAGE.margin + 14, startY, { width: CONTENT_WIDTH - 14 });
    doc.moveDown(0.15);
  }
}

/** Builds a styled header row from column definitions. */
function headerCells(
  columns: Array<{ label: string; x: number; width: number; align?: "left" | "right" }>,
): Cell[] {
  return columns.map((column) => ({
    text: column.label,
    x: column.x,
    width: column.width,
    align: column.align,
    bold: true,
    color: COLOR.muted,
  }));
}

/** Draws one table row and returns the y position of the next row. */
function drawRow(
  doc: PDFKit.PDFDocument,
  cells: Cell[],
  y: number,
  options: { background?: string; border?: boolean } = {},
): number {
  const height = 20;
  if (options.background) {
    doc.rect(PAGE.margin, y, CONTENT_WIDTH, height).fill(options.background);
  }
  for (const cell of cells) {
    doc
      .fillColor(cell.color ?? COLOR.text)
      .font(cell.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(9)
      .text(cell.text, cell.x, y + 6, {
        width: cell.width,
        align: cell.align ?? "left",
        lineBreak: false,
      });
  }
  if (options.border !== false) {
    doc
      .moveTo(PAGE.margin, y + height)
      .lineTo(PAGE.margin + CONTENT_WIDTH, y + height)
      .lineWidth(0.5)
      .strokeColor(COLOR.line)
      .stroke();
  }
  return y + height;
}

function metaGrid(doc: PDFKit.PDFDocument, entries: Array<[string, string]>): void {
  for (const [label, value] of entries) {
    ensureSpace(doc, 18);
    const y = doc.y;
    doc.fillColor(COLOR.muted).font("Helvetica").fontSize(9).text(label, PAGE.margin, y, { width: 130 });
    doc.fillColor(COLOR.text).fontSize(9).text(value, PAGE.margin + 134, y, {
      width: CONTENT_WIDTH - 134,
    });
    doc.y = y + 15;
  }
}

function titleBlock(
  doc: PDFKit.PDFDocument,
  title: string,
  subtitle: string,
): void {
  doc.fillColor(COLOR.accent).font("Helvetica-Bold").fontSize(18).text("Quorum");
  doc.fillColor(COLOR.text).font("Helvetica-Bold").fontSize(15).text(title);
  doc.fillColor(COLOR.muted).font("Helvetica").fontSize(10).text(subtitle);
  doc.moveDown(0.4);
}

function footer(doc: PDFKit.PDFDocument, generatedAt: Date): void {
  doc.font("Helvetica").fontSize(8).fillColor(COLOR.faint);
  const text = `Generated by Quorum on ${generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    const y = doc.page.height - PAGE.margin + 8;
    doc.text(text, PAGE.margin, y, { width: CONTENT_WIDTH * 0.7, lineBreak: false });
    doc.text(
      `Page ${index - range.start + 1} of ${range.count}`,
      PAGE.margin + CONTENT_WIDTH * 0.7,
      y,
      { width: CONTENT_WIDTH * 0.3, align: "right", lineBreak: false },
    );
  }
}

/** Renders a PDF and resolves with the finished bytes. */
function render(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  const doc = new PDFDocument({ size: PAGE.size, margin: PAGE.margin, bufferPages: true });
  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  build(doc);
  doc.end();
  return finished;
}

const DIMENSION_COLUMNS = [
  { label: "Dimension", x: PAGE.margin, width: 210 },
  { label: "Weight", x: PAGE.margin + 214, width: 60 },
  { label: "Score", x: PAGE.margin + 278, width: 60 },
  { label: "Assessment", x: PAGE.margin + 342, width: CONTENT_WIDTH - 342 },
];

function dimensionTable(doc: PDFKit.PDFDocument, participant: ReportParticipant): void {
  const rows = orderedDimensions(participant);
  ensureSpace(doc, 24 * (rows.length + 2) + 20);

  let y = doc.y;
  y = drawRow(doc, headerCells(DIMENSION_COLUMNS), y, { background: COLOR.panel });

  for (const row of rows) {
    const scored = !needsMoreEvidence(participant);
    y = drawRow(
      doc,
      [
        { text: row.label, x: DIMENSION_COLUMNS[0].x, width: DIMENSION_COLUMNS[0].width },
        {
          text: `${row.weight}%`,
          x: DIMENSION_COLUMNS[1].x,
          width: DIMENSION_COLUMNS[1].width,
          align: "right",
          color: COLOR.muted,
        },
        {
          text: scored ? row.score.toFixed(0) : "—",
          x: DIMENSION_COLUMNS[2].x,
          width: DIMENSION_COLUMNS[2].width,
          align: "right",
          bold: true,
          color: scored ? scoreColor(row.score) : COLOR.muted,
        },
        {
          text: scored ? `${scoreBand(row.score).label} · ${row.rationale.slice(0, 90)}` : "Not assessed",
          x: DIMENSION_COLUMNS[3].x,
          width: DIMENSION_COLUMNS[3].width,
          color: COLOR.muted,
        },
      ],
      y,
    );
  }

  doc.y = y + 6;
  doc.x = PAGE.margin;
}

function participantSection(doc: PDFKit.PDFDocument, participant: ReportParticipant): void {
  ensureSpace(doc, 150);
  doc.moveDown(0.4);

  const band = participant.band;
  doc
    .fillColor(COLOR.text)
    .font("Helvetica-Bold")
    .fontSize(12)
    .text(`${participant.name}${participant.isHost ? "  (host)" : ""}`, { continued: false });

  const summaryLine = participant.overallScore !== null
    ? `${participant.overallScore.toFixed(1)} / 100 — ${band?.label ?? ""}`
    : "Not assessed";
  doc
    .fillColor(scoreColor(participant.overallScore))
    .font("Helvetica-Bold")
    .fontSize(10)
    .text(summaryLine);

  doc.moveDown(0.3);
  metaGrid(doc, [
    ["Speaking time", `${formatDuration(participant.speakingMs)} (${participant.participationPct.toFixed(1)}% of the room)`],
    ["Contributions", `${participant.contributions} (${participant.wordCount} words)`],
    [
      "Relevance",
      participant.averageRelevance !== null
        ? `average ${participant.averageRelevance.toFixed(1)}/100 — ${participant.relevantCount} relevant, ${participant.partialCount} partial, ${participant.irrelevantCount} irrelevant`
        : "Not scored",
    ],
  ]);

  if (needsMoreEvidence(participant)) {
    doc.moveDown(0.3);
    doc
      .fillColor(COLOR.warn)
      .font("Helvetica-Oblique")
      .fontSize(10)
      .text(
        `No score was awarded. ${participant.incompleteReason ?? "There was not enough spoken content to assess this participant reliably."}`,
      );
    doc.moveDown(0.4);
  } else {
    doc.moveDown(0.4);
    dimensionTable(doc, participant);
  }

  if (participant.summary) {
    heading(doc, "Summary");
    paragraph(doc, participant.summary);
  }

  if (participant.notes.strengths.length > 0) {
    heading(doc, "Strengths");
    bulletList(doc, participant.notes.strengths);
  }
  if (participant.notes.improvements.length > 0) {
    heading(doc, "Areas to improve");
    bulletList(doc, participant.notes.improvements);
  }
  if (participant.notes.evidence.length > 0) {
    heading(doc, "Evidence from the transcript");
    bulletList(
      doc,
      participant.notes.evidence.map((quote) => `"${quote}"`),
    );
  }
}

function discussionMeta(doc: PDFKit.PDFDocument, report: DiscussionReport): void {
  metaGrid(doc, [
    ["Topic", report.discussion.topic],
    ["Format", report.discussion.mode === "AI_MODERATED" ? "AI-moderated group discussion" : "Free-flowing group discussion"],
    ["Host", report.discussion.hostName],
    ["Scheduled", formatDate(report.discussion.scheduledAt)],
    [
      "Ran",
      `${formatDate(report.discussion.startedAt)} → ${formatDate(report.discussion.endedAt)}`,
    ],
    ["Status", report.discussion.status],
    [
      "Stored transcript",
      report.transcript.length > 0
        ? `${report.transcript.length} entries, exportable from the discussion report page`
        : "No speech was transcribed",
    ],
    [
      "Stored recording",
      report.recording
        ? `${formatDuration(report.recording.durationMs)} of audio, playable from the discussion report page`
        : "No recording was captured for this session",
    ],
  ]);
  if (report.discussion.context) {
    doc.moveDown(0.3);
    paragraph(doc, report.discussion.context, { muted: true });
  }
}

/** Individual report for one participant. */
export function renderIndividualReport(
  report: DiscussionReport,
  participant: ReportParticipant,
): Promise<Buffer> {
  return render((doc) => {
    titleBlock(doc, "Individual evaluation report", report.discussion.title);

    heading(doc, "Participant");
    doc.font("Helvetica-Bold").fontSize(13).fillColor(COLOR.text).text(participant.name);
    if (participant.isHost) {
      doc.font("Helvetica").fontSize(9).fillColor(COLOR.muted).text("Host of this discussion");
    }
    doc.moveDown(0.3);

    const band = participant.band;
    doc
      .fillColor(scoreColor(participant.overallScore))
      .font("Helvetica-Bold")
      .fontSize(26)
      .text(participant.overallScore !== null ? participant.overallScore.toFixed(1) : "—", {
        continued: true,
      });
    doc
      .fillColor(COLOR.muted)
      .font("Helvetica")
      .fontSize(11)
      .text(participant.overallScore !== null ? ` / 100  ·  ${band?.label ?? ""}` : "  ·  Not assessed");
    doc.moveDown(0.5);

    metaGrid(doc, [
      ["Speaking time", `${formatDuration(participant.speakingMs)} (${participant.participationPct.toFixed(1)}% of the room's talking time)`],
      ["Contributions", `${participant.contributions} utterances, ${participant.wordCount} words`],
      [
        "Relevance verdicts",
        `${participant.relevantCount} relevant, ${participant.partialCount} partially relevant, ${participant.irrelevantCount} irrelevant`,
      ],
      ["Average relevance", participant.averageRelevance !== null ? `${participant.averageRelevance.toFixed(1)} / 100` : "Not scored"],
      ["Assessed by", report.participants.length > 0 ? "AI rubric scoring, weighted server-side" : "—"],
    ]);

    if (needsMoreEvidence(participant)) {
      heading(doc, "Assessment");
      doc
        .fillColor(COLOR.warn)
        .font("Helvetica-Bold")
        .fontSize(11)
        .text("This participant has not been rated.");
      doc.moveDown(0.2);
      paragraph(
        doc,
        participant.incompleteReason ??
          "There was not enough spoken content to assess this participant reliably.",
      );
    } else {
      heading(doc, "Rubric scores");
      dimensionTable(doc, participant);
      heading(doc, "Examiner rationale");
      for (const row of orderedDimensions(participant)) {
        ensureSpace(doc, 40);
        doc
          .fillColor(COLOR.text)
          .font("Helvetica-Bold")
          .fontSize(10)
          .text(`${row.label} (${row.weight}%) — ${row.score.toFixed(0)}/100`);
        doc.fillColor(COLOR.muted).font("Helvetica").fontSize(9).text(row.rationale || "No rationale recorded.");
        doc.moveDown(0.3);
      }
    }

    if (participant.summary) {
      heading(doc, "Summary");
      paragraph(doc, participant.summary);
    }
    if (participant.notes.strengths.length > 0) {
      heading(doc, "Strengths");
      bulletList(doc, participant.notes.strengths);
    }
    if (participant.notes.improvements.length > 0) {
      heading(doc, "Areas to improve");
      bulletList(doc, participant.notes.improvements);
    }
    if (participant.notes.evidence.length > 0) {
      heading(doc, "Evidence from the transcript");
      bulletList(
        doc,
        participant.notes.evidence.map((quote) => `"${quote}"`),
      );
    }

    heading(doc, "Discussion");
    discussionMeta(doc, report);

    footer(doc, report.generatedAt);
  });
}

/** Whole-room report: how the group performed and how balanced it was. */
export function renderOverallReport(report: DiscussionReport): Promise<Buffer> {
  return render((doc) => {
    titleBlock(doc, "Group discussion report", report.discussion.title);

    heading(doc, "Discussion");
    discussionMeta(doc, report);

    const aggregate = report.aggregate;
    heading(doc, "At a glance");
    doc
      .fillColor(scoreColor(aggregate.averageOverall))
      .font("Helvetica-Bold")
      .fontSize(26)
      .text(aggregate.averageOverall !== null ? aggregate.averageOverall.toFixed(1) : "—", { continued: true });
    doc
      .fillColor(COLOR.muted)
      .font("Helvetica")
      .fontSize(11)
      .text(
        aggregate.averageOverall !== null
          ? ` / 100  ·  average across ${aggregate.evaluatedCount} assessed participant${aggregate.evaluatedCount === 1 ? "" : "s"}`
          : "  ·  no participant had enough evidence to be assessed",
      );
    doc.moveDown(0.5);

    metaGrid(doc, [
      ["Participants", `${aggregate.participantCount} in the room, ${aggregate.evaluatedCount} assessed`],
      ["Talking time", `${formatDuration(aggregate.totalSpeakingMs)} across ${aggregate.totalContributions} contributions`],
      ["Total words", String(aggregate.totalWords)],
      [
        "Balance",
        aggregate.fairnessIndex !== null
          ? `${aggregate.fairnessIndex.toFixed(1)} / 100 (100 = everyone spoke an equal share)`
          : "Only one participant spoke",
      ],
      [
        "Relevance mix",
        `${aggregate.relevanceMix.highly} highly relevant, ${aggregate.relevanceMix.relevant} relevant, ${aggregate.relevanceMix.partial} partial, ${aggregate.relevanceMix.irrelevant} irrelevant`,
      ],
    ]);

    heading(doc, "Dimension averages");
    ensureSpace(doc, 24 * (aggregate.dimensionAverages.length + 2));
    let y = doc.y;
    y = drawRow(
      doc,
      headerCells([
        { label: "Dimension", x: PAGE.margin, width: 210 },
        { label: "Weight", x: PAGE.margin + 214, width: 60 },
        { label: "Average", x: PAGE.margin + 278, width: 60 },
        { label: "Assessment", x: PAGE.margin + 342, width: CONTENT_WIDTH - 342 },
      ]),
      y,
      { background: COLOR.panel },
    );
    for (const row of aggregate.dimensionAverages) {
      y = drawRow(
        doc,
        [
          { text: row.label, x: PAGE.margin, width: 210 },
          { text: `${row.weight}%`, x: PAGE.margin + 214, width: 60, align: "right", color: COLOR.muted },
          {
            text: row.score > 0 ? row.score.toFixed(1) : "—",
            x: PAGE.margin + 278,
            width: 60,
            align: "right",
            bold: true,
            color: scoreColor(row.score > 0 ? row.score : null),
          },
          {
            text: row.score > 0 ? scoreBand(row.score).label : "Not scored",
            x: PAGE.margin + 342,
            width: CONTENT_WIDTH - 342,
            color: COLOR.muted,
          },
        ],
        y,
      );
    }
    doc.y = y + 6;
    doc.x = PAGE.margin;

    heading(doc, "Participants");
    if (report.participants.length === 0) {
      paragraph(doc, "No participant reports are available to you.", { muted: true });
    } else {
      let rowY = doc.y;
      rowY = drawRow(
        doc,
        headerCells([
          { label: "Participant", x: PAGE.margin, width: 190 },
          { label: "Overall", x: PAGE.margin + 194, width: 70, align: "right" },
          { label: "Talking share", x: PAGE.margin + 268, width: 85, align: "right" },
          { label: "Contributions", x: PAGE.margin + 357, width: 80, align: "right" },
          { label: "Result", x: PAGE.margin + 441, width: CONTENT_WIDTH - 441 },
        ]),
        rowY,
        { background: COLOR.panel },
      );
      for (const participant of report.participants) {
        rowY = drawRow(
          doc,
          [
            { text: participant.name, x: PAGE.margin, width: 190 },
            {
              text: participant.overallScore !== null ? participant.overallScore.toFixed(1) : "—",
              x: PAGE.margin + 194,
              width: 70,
              align: "right",
              bold: true,
              color: scoreColor(participant.overallScore),
            },
            {
              text: `${participant.participationPct.toFixed(1)}%`,
              x: PAGE.margin + 268,
              width: 85,
              align: "right",
              color: COLOR.muted,
            },
            {
              text: String(participant.contributions),
              x: PAGE.margin + 357,
              width: 80,
              align: "right",
              color: COLOR.muted,
            },
            {
              text: participant.overallScore !== null ? (participant.band?.label ?? "") : "Not assessed",
              x: PAGE.margin + 441,
              width: CONTENT_WIDTH - 441,
              color: participant.overallScore !== null ? scoreColor(participant.overallScore) : COLOR.warn,
            },
          ],
          rowY,
        );
      }
      doc.y = rowY + 6;
      doc.x = PAGE.margin;
    }

    if (report.aggregate.evaluatedCount > 0) {
      for (const participant of report.participants.filter((p) => !needsMoreEvidence(p))) {
        heading(doc, `Detail — ${participant.name}`);
        if (participant.summary) paragraph(doc, participant.summary);
        doc.moveDown(0.3);
        if (participant.notes.strengths.length > 0) {
          doc.font("Helvetica-Bold").fontSize(10).fillColor(COLOR.text).text("Strengths");
          bulletList(doc, participant.notes.strengths);
        }
        if (participant.notes.improvements.length > 0) {
          doc.font("Helvetica-Bold").fontSize(10).fillColor(COLOR.text).text("Areas to improve");
          bulletList(doc, participant.notes.improvements);
        }
      }
    }

    if (report.transcript.length > 0) {
      heading(doc, "Transcript appendix");
      for (const line of report.transcript) {
        ensureSpace(doc, 26);
        doc
          .fillColor(COLOR.muted)
          .font("Helvetica")
          .fontSize(8)
          .text(
            `${line.speaker}${line.speakerIsHost ? " (host)" : ""} · ${line.startedAt.toISOString().slice(11, 19)} UTC · ${line.relevance.toLowerCase().replace(/_/g, " ")}`,
          );
        doc.fillColor(COLOR.text).fontSize(9).text(line.text, { width: CONTENT_WIDTH });
        doc.moveDown(0.25);
      }
    }

    footer(doc, report.generatedAt);
  });
}
