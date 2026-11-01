import { useEffect, useRef, useState } from 'react';
import { LoadingPulse } from '../ui/ld';
import { useTokenRates } from './use-token-rates';
import { formatTokensPerSecond } from './token-rate';
import './progress-bar.scss';

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/**
 * Live "Working" status shown while the agent turn is in progress. Mounts when
 * streaming starts and unmounts when it ends, so its timer measures the turn — and
 * so the throughput readout below it never has to outlive the run it describes.
 */
export function ProgressBar() {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());
  const { decode, prefill } = useTokenRates();

  useEffect(() => {
    startRef.current = Date.now();
    setElapsed(0);
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="progress-bar" role="status" aria-live="polite">
      <LoadingPulse variant="march" size="md" className="progress-dots" />
      <span className="progress-label">Working</span>
      <span className="progress-time">{formatDuration(elapsed)}</span>
      {(decode != null || prefill != null) && (
        <span className="progress-rates" aria-hidden="true">
          {decode != null && (
            <>
              <span
                className="progress-rate"
                title="Output tokens per second (decode)">
                {`D:${formatTokensPerSecond(decode)} t/s`}
              </span>
              {prefill != null && <span className="progress-rate-sep">|</span>}
            </>
          )}
          {prefill != null && (
            <span
              className="progress-rate"
              title="Prompt tokens per second (prefill, cached reads included), estimated from time-to-first-token">
              {`P:${formatTokensPerSecond(prefill)} t/s`}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
