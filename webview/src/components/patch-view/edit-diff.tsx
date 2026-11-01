import './edit-diff.scss';

interface Edit {
  oldText: string;
  newText: string;
}

function diffLines(
  oldText: string,
  newText: string,
): { context: string[]; removed: string[]; added: string[] } {
  const oldLines = linesOf(oldText);
  const newLines = linesOf(newText);
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  )
    start++;
  let endO = oldLines.length;
  let endN = newLines.length;
  while (
    endO > start &&
    endN > start &&
    oldLines[endO - 1] === newLines[endN - 1]
  ) {
    endO--;
    endN--;
  }
  return {
    context: oldLines.slice(Math.max(0, start - 2), start),
    removed: oldLines.slice(start, endO),
    added: newLines.slice(start, endN),
  };
}

/**
 * A text as display lines. An empty text is an absent file, not a file with one blank
 * line — which is what a `write` (no previous content) and an empty edit side both mean.
 * A closing line ending terminates the last line rather than adding an empty row, so a
 * whole file counts the same here as it does in the streaming write preview.
 */
function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function DiffBlock({ oldText, newText }: Edit) {
  const { context, removed, added } = diffLines(oldText, newText);
  // A whole-file addition is a new file, not a change to one: it gets the softer palette
  // and the square corners a `write` card expects.
  const additionsOnly = oldText === '';
  return (
    <pre
      className={`patch-container${additionsOnly ? ' patch-additions-only exec-write-highlight' : ''}`}>
      {context.map((l, i) => (
        <div key={`c${i}`} className="patch-line patch-line-context">
          {' '}
          {l}
        </div>
      ))}
      {removed.map((l, i) => (
        <div key={`d${i}`} className="patch-line patch-line-del">
          - {l}
        </div>
      ))}
      {added.map((l, i) => (
        <div key={`a${i}`} className="patch-line patch-line-add">
          + {l}
        </div>
      ))}
    </pre>
  );
}

export function PatchView({ edits }: { edits: Edit[] }) {
  if (edits.length === 0) return null;
  return (
    <div className="patch-stats">
      {edits.map((e, i) => (
        <DiffBlock
          key={i}
          oldText={e.oldText ?? ''}
          newText={e.newText ?? ''}
        />
      ))}
    </div>
  );
}
