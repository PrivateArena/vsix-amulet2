import { useState } from 'react';
import { LuChevronRight, LuMinimize2 } from 'react-icons/lu';
import type { CompactionInfo } from '../../../store';
import { compactionStats, compactionTitle } from './compaction-display';
import { MdRender } from '../../md-render';
import './compaction-card.scss';

interface CompactionCardProps {
  info: CompactionInfo;
  /**
   * Show the summary without a click. The transcript keeps a collapsed card because a boundary is
   * a divider, not a message; the compact-history dialog has nowhere else to put it.
   */
  defaultExpanded?: boolean;
}

/**
 * A compaction boundary in the transcript, or the whole of the compact-history dialog.
 *
 * The same card serves both sources: the live `compaction_end` event, and a boundary read back off
 * pi's persisted entry — the latter carries the summary, the token count it replaced and the file
 * lists, but no reason, duration or post-compaction estimate, so every figure beyond those is
 * optional by design.
 */
export function CompactionCard({
  info,
  defaultExpanded = false,
}: CompactionCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const summary = info.summary?.trim();
  // pi also appends `<read-files>`/`<modified-files>` blocks to the summary text itself, but
  // markdown rendering drops unknown raw HTML, so those tags are invisible here — the list
  // rebuilt from `details` is the only readable form, and it is what a boundary opened from the
  // compact-history dialog shows too: the host reads those lists back off the persisted entry.
  const files = [
    ...(info.readFiles?.map((path) => ({ label: 'read', path })) ?? []),
    ...(info.modifiedFiles?.map((path) => ({ label: 'edited', path })) ?? []),
  ];
  const hasBody = !!summary || files.length > 0;

  return (
    <div
      className={`compaction-card is-${info.outcome}${expanded ? ' is-expanded' : ''}`}>
      <button
        type="button"
        className="compaction-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        disabled={!hasBody}>
        <LuChevronRight className="compaction-chevron" aria-hidden="true" />
        <LuMinimize2 className="compaction-glyph" aria-hidden="true" />
        <span className="compaction-title">{compactionTitle(info)}</span>
        <span className="compaction-meta">
          {compactionStats(info).join(' · ')}
        </span>
      </button>
      {info.outcome === 'failed' && info.error && (
        <div className="compaction-error">{info.error}</div>
      )}
      {expanded && hasBody && (
        <div className="compaction-body">
          {summary && <MdRender>{summary}</MdRender>}
          {files.length > 0 && (
            <ul className="compaction-files">
              {files.map((f) => (
                <li key={`${f.label}:${f.path}`}>
                  <span className="compaction-file-kind">{f.label}</span>
                  <code>{f.path}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
