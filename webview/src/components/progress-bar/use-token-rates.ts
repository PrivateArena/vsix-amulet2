import { useEffect, useRef, useState } from 'react';
import { useChatState } from '../../contexts/chat-context';
import type { UiMessage } from '../../store';
import { createTurnMeter, NO_RATES, type TokenRates } from './turn-meter';

/** Re-measurement period: steadier than the delta stream, cheaper than one per token. */
const TICK_MS = 400;

/**
 * The assistant message currently streaming, which is the message the runtime is
 * generating into — `currentUid`, not a scan for a `streaming` flag: a run that ended
 * without a `message_end` (a Stop, a dropped event) leaves that flag set, and the next
 * run would otherwise start out reporting the previous run's throughput.
 */
function streamingMessage(
  messages: UiMessage[],
  currentUid: string | null,
): UiMessage | null {
  if (!currentUid) return null;
  const message = messages.find((m) => m.uid === currentUid);
  return message && message.role === 'assistant' && message.streaming
    ? message
    : null;
}

/**
 * Live token throughput of the running turn.
 *
 * The readout stays on `NO_RATES` — so the indicator renders only its duration — until
 * there is a measurement worth showing, and it dies with the component, which is what
 * keeps a rate from surviving into the next run.
 */
export function useTokenRates(): TokenRates {
  const { messages, currentUid } = useChatState();
  const targetRef = useRef<UiMessage | null>(null);
  const [rates, setRates] = useState<TokenRates>(NO_RATES);

  useEffect(() => {
    targetRef.current = streamingMessage(messages, currentUid);
  });

  useEffect(() => {
    const meter = createTurnMeter();
    const tick = () => {
      const next = meter.measure(Date.now(), targetRef.current);
      setRates((prev) =>
        prev.decode === next.decode && prev.prefill === next.prefill
          ? prev
          : next,
      );
    };
    const id = setInterval(tick, TICK_MS);
    tick();
    return () => clearInterval(id);
  }, []);

  return rates;
}
