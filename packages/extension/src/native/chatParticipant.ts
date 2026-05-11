import { BuildrCore } from "@buildr/core";
import * as vscode from "vscode";

export function registerBuildrChatParticipant(context: vscode.ExtensionContext, core: BuildrCore): void {
  const chatApi = vscode.chat;
  if (chatApi === undefined) {
    return;
  }

  const participant = chatApi.createChatParticipant("buildr.chat", (request, _chatContext, stream, token) => {
    const goal = request.prompt.trim();
    if (goal.length === 0) {
      stream.markdown("Tell Buildr what you want to plan.");
      return;
    }

    if (token.isCancellationRequested) {
      stream.markdown("Buildr chat request was cancelled.");
      return;
    }

    const plan = core.createPlan(goal);
    stream.markdown(`Created a ${plan.steps.length}-step Buildr plan for: **${plan.goal}**\n\n`);
    for (const step of plan.steps) {
      stream.markdown(`- **${step.title}** (${step.kind}, ${step.risk})\n`);
    }
  });

  context.subscriptions.push(participant);
}
