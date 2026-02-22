import { useEffect, useRef, useState } from 'react';
import { TOOL_TO_LINK } from '../types';

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
  sourceId: string;
}

interface ConnectorLinesProps {
  activeTools: Set<string>;
}

function ConnectorLines({ activeTools }: ConnectorLinesProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [lines, setLines] = useState<LineCoords[]>([]);

  // Derive which sourceIds are currently active
  const activeSourceIds = new Set(
    [...activeTools].map(tool => TOOL_TO_LINK[tool]).filter(Boolean)
  );

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
            sourceId,
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
        <filter id="blob-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {lines.map((line, i) => {
        const dx = line.x2 - line.x1;
        const cp1x = line.x1 + dx * 0.4;
        const cp2x = line.x2 - dx * 0.4;

        const path = `M ${line.x1} ${line.y1} C ${cp1x} ${line.y1}, ${cp2x} ${line.y2}, ${line.x2} ${line.y2}`;
        const isActive = activeSourceIds.has(line.sourceId);

        return (
          <g key={i}>
            {/* Glow effect — brighter when active */}
            <path
              d={path}
              fill="none"
              stroke={line.color}
              strokeWidth={isActive ? 10 : 6}
              strokeOpacity={isActive ? 0.2 : 0.1}
              strokeLinecap="round"
            />
            {/* Main line — faster dash animation when active */}
            <path
              d={path}
              fill="none"
              stroke={`url(#line-gradient-${i})`}
              strokeWidth={isActive ? 3 : 2}
              strokeOpacity={isActive ? 0.9 : 1}
              strokeDasharray="8 6"
              strokeLinecap="round"
            >
              <animate
                attributeName="stroke-dashoffset"
                from="28"
                to="0"
                dur={isActive ? '0.8s' : '2s'}
                repeatCount="indefinite"
              />
            </path>
            {/* Source dot — pulses faster when active */}
            <circle
              cx={line.x1}
              cy={line.y1}
              r="4"
              fill={line.color}
              opacity="0.8"
              filter={isActive ? 'url(#blob-glow)' : undefined}
            >
              <animate
                attributeName="opacity"
                values="0.4;0.9;0.4"
                dur={isActive ? '0.8s' : '2s'}
                repeatCount="indefinite"
              />
              {isActive && (
                <animate
                  attributeName="r"
                  values="4;6;4"
                  dur="0.8s"
                  repeatCount="indefinite"
                />
              )}
            </circle>
            {/* Target dot */}
            <circle
              cx={line.x2}
              cy={line.y2}
              r="3"
              fill={line.color}
              opacity="0.5"
            />
            {/* Traveling blobs — only when tool is active */}
            {isActive && (
              <>
                <circle r="5" fill={line.color} opacity="0.9" filter="url(#blob-glow)">
                  <animateMotion dur="1.2s" repeatCount="indefinite" path={path} />
                </circle>
                <circle r="3.5" fill={line.color} opacity="0.6" filter="url(#blob-glow)">
                  <animateMotion dur="1.2s" repeatCount="indefinite" path={path} begin="0.6s" />
                </circle>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export default ConnectorLines;
