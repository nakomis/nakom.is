import { useEffect, useRef, useState } from 'react';

interface Connection {
  sourceId: string;
  color: string;
}

const connections: Connection[] = [
  { sourceId: 'link-cv', color: '#ff8c00' },
  { sourceId: 'link-linkedin', color: '#0077b5' },
  { sourceId: 'link-github', color: '#f0f0f0' },
];

interface LineCoords {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}

function ConnectorLines() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [lines, setLines] = useState<LineCoords[]>([]);

  useEffect(() => {
    const updateLines = () => {
      const chatPanel = document.getElementById('chat-panel');
      if (!chatPanel) {
        setLines([]);
        return;
      }

      const chatRect = chatPanel.getBoundingClientRect();

      const newLines: LineCoords[] = connections
        .map(({ sourceId, color }) => {
          const sourceEl = document.getElementById(sourceId);
          if (!sourceEl) return null;

          const sourceRect = sourceEl.getBoundingClientRect();

          return {
            x1: sourceRect.right + 4,
            y1: sourceRect.top + sourceRect.height / 2,
            x2: chatRect.left - 4,
            y2: chatRect.top + 60 + connections.findIndex(c => c.sourceId === sourceId) * 40,
            color,
          };
        })
        .filter((l): l is LineCoords => l !== null);

      setLines(newLines);
    };

    updateLines();

    window.addEventListener('resize', updateLines);
    window.addEventListener('scroll', updateLines);

    const observer = new MutationObserver(updateLines);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      window.removeEventListener('resize', updateLines);
      window.removeEventListener('scroll', updateLines);
      observer.disconnect();
    };
  }, []);

  if (lines.length === 0) return null;

  return (
    <svg
      ref={svgRef}
      className="connector-svg"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: 500,
      }}
    >
      <defs>
        {lines.map((line, i) => (
          <linearGradient
            key={`grad-${i}`}
            id={`line-gradient-${i}`}
            x1="0%"
            y1="0%"
            x2="100%"
            y2="0%"
          >
            <stop offset="0%" stopColor={line.color} stopOpacity="0.8" />
            <stop offset="100%" stopColor={line.color} stopOpacity="0.3" />
          </linearGradient>
        ))}
      </defs>

      {lines.map((line, i) => {
        const dx = line.x2 - line.x1;
        const cp1x = line.x1 + dx * 0.4;
        const cp2x = line.x2 - dx * 0.4;

        const path = `M ${line.x1} ${line.y1} C ${cp1x} ${line.y1}, ${cp2x} ${line.y2}, ${line.x2} ${line.y2}`;

        return (
          <g key={i}>
            {/* Glow effect */}
            <path
              d={path}
              fill="none"
              stroke={line.color}
              strokeWidth="6"
              strokeOpacity="0.1"
              strokeLinecap="round"
            />
            {/* Main line */}
            <path
              d={path}
              fill="none"
              stroke={`url(#line-gradient-${i})`}
              strokeWidth="2"
              strokeDasharray="8 6"
              strokeLinecap="round"
            >
              <animate
                attributeName="stroke-dashoffset"
                from="28"
                to="0"
                dur="2s"
                repeatCount="indefinite"
              />
            </path>
            {/* Source dot */}
            <circle
              cx={line.x1}
              cy={line.y1}
              r="4"
              fill={line.color}
              opacity="0.8"
            >
              <animate
                attributeName="opacity"
                values="0.4;0.9;0.4"
                dur="2s"
                repeatCount="indefinite"
              />
            </circle>
            {/* Target dot */}
            <circle
              cx={line.x2}
              cy={line.y2}
              r="3"
              fill={line.color}
              opacity="0.5"
            />
          </g>
        );
      })}
    </svg>
  );
}

export default ConnectorLines;
