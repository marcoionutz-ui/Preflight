/**
 * discovery/logStack.ts
 * Parser pentru Solana program log stack.
 * Shared intre clmmShadow.ts (diagnostics) si clmmFetcher.ts (production).
 */

const PROGRAM_INVOKE_RE = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke/;
const PROGRAM_EXIT_RE   = /^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed)/;
const INSTRUCTION_RE    = /^Program log: Instruction:\s*([A-Za-z0-9_]+)/;

/**
 * Extrage instruction names emise DOAR de targetProgramId.
 * Trateaza logs-urile ca un call stack — ignora instruction-uri
 * emise de alte programe (Token Program, ATA, Jupiter etc.)
 */
export function extractTargetProgramInstructions(
  logs:            string[],
  targetProgramId: string,
): string[] {
  const stack: string[] = [];
  const out:   string[] = [];

  for (const line of logs) {
    const invoke = line.match(PROGRAM_INVOKE_RE);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }

    const instruction = line.match(INSTRUCTION_RE);
    if (instruction && stack[stack.length - 1] === targetProgramId) {
      out.push(instruction[1]);
      continue;
    }

    const exit = line.match(PROGRAM_EXIT_RE);
    if (exit) {
      const idx = stack.lastIndexOf(exit[1]);
      if (idx >= 0) stack.splice(idx);
    }
  }

  return out;
}
