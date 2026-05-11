import React from "react";
import { Box, renderToString, Text } from "ink";
import type { ExecutionEvent } from "@buildr/core";

export interface StepReport {
  title: string;
  summary: string;
  events: ExecutionEvent[];
  warnings?: string[];
}

export function renderStepReportToString(report: StepReport): string {
  return renderToString(React.createElement(StepReportView, { report }), { columns: 100 });
}

function StepReportView({ report }: { report: StepReport }) {
  return React.createElement(
    Box,
    { flexDirection: "column", padding: 1, borderStyle: "round", borderColor: "cyan" },
    React.createElement(Text, { bold: true, color: "cyan" }, report.title),
    React.createElement(Text, undefined, report.summary),
    ...report.events.map((event) => React.createElement(
      Text,
      { key: event.id, color: colorForStatus(event.status) },
      `${symbolForStatus(event.status)} ${event.title}: ${event.summary}`
    )),
    ...(report.warnings ?? []).map((warning) => React.createElement(
      Text,
      { key: warning, color: "yellow" },
      `! ${warning}`
    ))
  );
}

function symbolForStatus(status: ExecutionEvent["status"]): string {
  switch (status) {
    case "completed":
      return "[ok]";
    case "failed":
      return "[fail]";
    case "blocked":
      return "[blocked]";
    case "running":
      return "[run]";
    case "queued":
      return "[pending]";
    case "pending_approval":
      return "[approval]";
  }
}

function colorForStatus(status: ExecutionEvent["status"]): "green" | "red" | "yellow" | "blue" | "gray" {
  switch (status) {
    case "completed":
      return "green";
    case "failed":
      return "red";
    case "blocked":
      return "yellow";
    case "running":
      return "blue";
    case "queued":
    case "pending_approval":
      return "gray";
  }
}
