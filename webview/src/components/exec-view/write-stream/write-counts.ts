import { countStreamLines } from '../stream-tail';

/**
 * The `+N lines` figure in a write card's header. It is the one number that moves while
 * the model types the body, and it goes on describing the file once the call has settled.
 */
export function writeLineBadge(content: string | undefined): string {
  const lines = countStreamLines(content);
  if (lines === 0) return '';
  return `+${lines} ${lines === 1 ? 'line' : 'lines'}`;
}
