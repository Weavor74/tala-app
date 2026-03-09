/**
 * EmotionDisplay Widget
 * 
 * A compact radar (spider) chart visualizing TALA's internal emotional vector.
 * 
 * **Visuals:**
 * - Radar Chart: Maps 8 emotional axes (Warmth, Focus, Confidence, Calm, Empathy, Fear, Anger, Lust).
 * - Real-time Integration: Listens for `astro-update` and `chat-done` events to refresh the state.
 * - UX: Displays as a small indicator dot in the header, expanding into a full chart on hover.
 * 
 * **Data Source:**
 * - Leverages the `AstroEngine` (via `getEmotionState`) to obtain a high-dimensionality mood vector.
 */
import React, { useState, useEffect, useCallback } from 'react';

interface EmotionVector {
    warmth: number;
    focus: number;
    confidence: number;
    calm: number;
    empathy: number;
    fear: number;
    anger: number;
    lust: number;
}

const AXES: (keyof EmotionVector)[] = [
    'warmth', 'focus', 'confidence', 'calm', 'empathy', 'fear', 'anger', 'lust'
];
const AXIS_LABELS = ['Warmth', 'Focus', 'Confidence', 'Calm', 'Empathy', 'Fear', 'Anger', 'Lust'];
const COLORS: Record<string, string> = {
    warmth: '#ff9f43', focus: '#54a0ff', confidence: '#20bf6b', calm: '#26de81',
    empathy: '#ff6b6b', fear: '#8854d0', anger: '#ee5a24', lust: '#f368e0'
};

const DEFAULT_VECTOR: EmotionVector = {
    warmth: 0.5, focus: 0.5, confidence: 0.5, calm: 0.5, empathy: 0.5,
    fear: 0.0, anger: 0.0, lust: 0.0
};

/** Parses the emotion vector from the astro state text. */
function parseVector(text: string): EmotionVector | null {
    const vec: any = { ...DEFAULT_VECTOR };
    let found = false;
    for (const axis of AXES) {
        // Match patterns like "Warmth: 0.72" or "warmth=0.72"
        const re = new RegExp(`${axis}[:\\s=]+([0-9.]+)`, 'i');
        const m = text.match(re);
        if (m) {
            vec[axis] = Math.max(0, Math.min(1, parseFloat(m[1])));
            found = true;
        }
    }
    return found ? vec : null;
}

/** Polar coordinate helper for SVG radar chart. */
function polarToXY(cx: number, cy: number, r: number, angle: number): [number, number] {
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
}

interface Props {
    isStreaming?: boolean;
}

export const EmotionDisplay: React.FC<Props> = ({ isStreaming }) => {
    const [vector, setVector] = useState<EmotionVector>(DEFAULT_VECTOR);
    const [online, setOnline] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const api = (window as any).tala;

    const fetchState = useCallback(async () => {
        if (api?.getEmotionState) {
            try {
                const raw: string = await api.getEmotionState();
                if (raw && !raw.includes('offline') && !raw.includes('Error')) {
                    const parsed = parseVector(raw);
                    if (parsed) {
                        setVector(parsed);
                        setOnline(true);
                        return;
                    }
                }
            } catch { /* silent */ }
            setOnline(false);
        }
    }, [api]);

    // Fetch on mount
    useEffect(() => { fetchState(); }, [fetchState]);

    // Refresh on startup progress (to catch the "Ready" transition)
    useEffect(() => {
        if (!api?.on) return;
        const handler = (status: { step: string; progress: number }) => {
            if (status.step === 'Ready' || status.progress === 100) {
                fetchState();
            }
        };
        api.on('startup-status', handler);
        return () => { if (api.off) api.off('startup-status', handler); };
    }, [api, fetchState]);

    // Refresh on periodic telemetry updates
    useEffect(() => {
        if (!api?.on) return;
        const handler = (raw: string) => {
            if (raw && !raw.includes('offline') && !raw.includes('Error')) {
                const parsed = parseVector(raw);
                if (parsed) {
                    setVector(parsed);
                    setOnline(true);
                }
            }
        };
        api.on('astro-update', handler);
        return () => { if (api.off) api.off('astro-update', handler); };
    }, [api]);

    // Refresh after each chat response completes
    useEffect(() => {
        if (!api?.on) return;
        const handler = () => { if (!isStreaming) fetchState(); };
        api.on('chat-done', handler);
        return () => { if (api.off) api.off('chat-done', handler); };
    }, [api, isStreaming, fetchState]);

    // Radar chart constants
    const size = 300; // Final size adjustment for extreme clearance
    const cx = size / 2;
    const cy = size / 2;
    const maxR = 60;
    const ringCount = 3;
    const angleStep = (2 * Math.PI) / AXES.length;
    const startAngle = -Math.PI / 2; // Top

    // Data polygon points
    const dataPoints = AXES.map((axis, i) => {
        const angle = startAngle + i * angleStep;
        const r = vector[axis] * maxR;
        return polarToXY(cx, cy, r, angle);
    });
    const dataPath = dataPoints.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ') + ' Z';

    return (
        <div
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer', position: 'relative' }}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            {/* Mini indicator dot */}
            <div style={{
                width: 8, height: 8, borderRadius: '50%',
                background: online ? '#20bf6b' : '#666',
                boxShadow: online ? '0 0 6px #20bf6b' : 'none',
                flexShrink: 0,
            }} />
            <span style={{ fontSize: 10, color: '#888', letterSpacing: 0.5 }}>
                {online ? 'MOOD' : 'ASTRO'}
            </span>

            {/* Hover tooltip with full radar chart */}
            {isHovered && (
                <div style={{
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    zIndex: 1000,
                    background: '#1e1e1e',
                    border: '1px solid #333',
                    borderRadius: 8,
                    padding: 12,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
                    minWidth: 340,
                }}>
                    <svg width={size} height={size} style={{ display: 'block', margin: '0 auto' }}>
                        {/* Grid rings */}
                        {Array.from({ length: ringCount }).map((_, ri) => {
                            const r = maxR * ((ri + 1) / ringCount);
                            const pts = AXES.map((_, i) => polarToXY(cx, cy, r, startAngle + i * angleStep));
                            const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ') + ' Z';
                            return <path key={ri} d={d} fill="none" stroke="#333" strokeWidth="0.5" />;
                        })}
                        {/* Axis lines */}
                        {AXES.map((_, i) => {
                            const [x, y] = polarToXY(cx, cy, maxR, startAngle + i * angleStep);
                            return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="#333" strokeWidth="0.5" />;
                        })}
                        {/* Data polygon */}
                        <path d={dataPath} fill="rgba(84,160,255,0.2)" stroke="#54a0ff" strokeWidth="1.5" />
                        {/* Data points */}
                        {dataPoints.map(([x, y], i) => (
                            <circle key={i} cx={x} cy={y} r={2.5} fill={COLORS[AXES[i]]} />
                        ))}
                        {/* Labels */}
                        {AXES.map((axis, i) => {
                            const [x, y] = polarToXY(cx, cy, maxR + 40, startAngle + i * angleStep);
                            return (
                                <text key={axis} x={x} y={y} fill="#eee" fontSize="10" fontWeight="600" textAnchor="middle" dominantBaseline="central">
                                    {AXIS_LABELS[i]}
                                </text>
                            );
                        })}
                    </svg>
                    {/* Axis values */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px', marginTop: 8 }}>
                        {AXES.map((axis, i) => (
                            <div key={axis} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
                                <span style={{ width: 6, height: 6, borderRadius: '50%', background: COLORS[axis], flexShrink: 0 }} />
                                <span style={{ color: '#888' }}>{AXIS_LABELS[i]}</span>
                                <span style={{ marginLeft: 'auto', color: '#ccc' }}>{(vector[axis] * 100).toFixed(0)}%</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};
