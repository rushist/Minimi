import { lazy, Suspense, useEffect, useState } from 'react';

const GradientASCII = lazy(() => import('./reactbits/GradientASCII.js'));
const colors = ['#1e3fd8', '#f6f8ff', '#a5d8ff', '#38bdf8'];

export function ChatBackdrop({ visible }: { visible: boolean }) {
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), 380);
    return () => clearTimeout(timer);
  }, [visible]);

  if (!mounted) return null;
  return (
    <div
      className="new-chat-backdrop"
      data-visible={visible}
      aria-hidden="true"
    >
      <Suspense fallback={null}>
        <GradientASCII
          colors={colors}
          shape="horizon"
          characters=" =+xX0S8#@"
          cellSize={18}
          density={0.8}
          glyphOpacity={0.85}
          glow={0.2}
          depthOfField={0}
          flicker={0.2}
          softness={0.5}
          scale={1}
          flow={0.5}
          speed={1}
          gradientOpacity={0.9}
          grain={0.08}
          variation={0}
          mouseInteraction
          scrambleRadius={0.1}
          clickEffect="wave"
          intro
          lightMode={false}
        />
      </Suspense>
    </div>
  );
}
