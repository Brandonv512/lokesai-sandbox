import {
    AbsoluteFill,
    useCurrentFrame,
    useVideoConfig,
    interpolate,
    spring,
} from "remotion";
import React from "react";

const COLORS = {
    cyan: "#00e5a0",
    gold: "#c6a664",
    goldBright: "#e5c98d",
    cyanDim: "rgba(0, 229, 160, 0.3)",
    goldDim: "rgba(198, 166, 100, 0.3)",
    inactive: "rgba(255, 255, 255, 0.15)",
    line: "rgba(255, 255, 255, 0.08)",
};

interface PipelineNode {
    label: string;
    x: number;
    activateAt: number;
    completeAt: number;
}

const LINE_Y = 40;
const NODE_RADIUS = 14;
const PADDING_X = 80;
const LINE_WIDTH = 1200 - PADDING_X * 2;

const NODES: PipelineNode[] = [
    { label: "Prompt", x: PADDING_X, activateAt: 0, completeAt: 20 },
    { label: "Image", x: PADDING_X + LINE_WIDTH * 0.333, activateAt: 15, completeAt: 40 },
    { label: "Video", x: PADDING_X + LINE_WIDTH * 0.666, activateAt: 35, completeAt: 60 },
    { label: "Upload", x: PADDING_X + LINE_WIDTH, activateAt: 55, completeAt: 75 },
];

export const PipelineFlow: React.FC = () => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();

    // Overall line fill progress
    const lineFillProgress = interpolate(frame, [5, 75], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
    });

    // Energy pulse position along the line
    const pulseProgress = interpolate(frame, [0, 85], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
    });
    const pulseX = PADDING_X + LINE_WIDTH * pulseProgress;

    // Ambient glow pulse
    const glowPulse = interpolate(
        Math.sin((frame / fps) * Math.PI * 3),
        [-1, 1],
        [0.6, 1.0]
    );

    return (
        <AbsoluteFill
            style={{
                backgroundColor: "#000000",
                overflow: "hidden",
            }}
        >
            <svg width={1200} height={80} viewBox="0 0 1200 80">
                <defs>
                    {/* Gradient for the filled line */}
                    <linearGradient id="lineGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor={COLORS.cyan} />
                        <stop offset="50%" stopColor={COLORS.goldBright} />
                        <stop offset="100%" stopColor={COLORS.gold} />
                    </linearGradient>

                    {/* Glow filter for nodes */}
                    <filter id="nodeGlow">
                        <feGaussianBlur stdDeviation="4" result="blur" />
                        <feMerge>
                            <feMergeNode in="blur" />
                            <feMergeNode in="blur" />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>

                    {/* Glow filter for the line */}
                    <filter id="lineGlowFilter">
                        <feGaussianBlur stdDeviation="2" result="blur" />
                        <feMerge>
                            <feMergeNode in="blur" />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>

                    {/* Energy pulse glow */}
                    <filter id="pulseGlow">
                        <feGaussianBlur stdDeviation="6" result="blur" />
                        <feMerge>
                            <feMergeNode in="blur" />
                            <feMergeNode in="blur" />
                            <feMergeNode in="blur" />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>

                    {/* Clip the filled line to the progress */}
                    <clipPath id="lineClip">
                        <rect
                            x={PADDING_X}
                            y={0}
                            width={LINE_WIDTH * lineFillProgress}
                            height={80}
                        />
                    </clipPath>
                </defs>

                {/* Background track line */}
                <line
                    x1={PADDING_X}
                    y1={LINE_Y}
                    x2={PADDING_X + LINE_WIDTH}
                    y2={LINE_Y}
                    stroke={COLORS.line}
                    strokeWidth={2}
                    strokeLinecap="round"
                />

                {/* Filled glowing line with gradient */}
                <line
                    x1={PADDING_X}
                    y1={LINE_Y}
                    x2={PADDING_X + LINE_WIDTH}
                    y2={LINE_Y}
                    stroke="url(#lineGradient)"
                    strokeWidth={3}
                    strokeLinecap="round"
                    clipPath="url(#lineClip)"
                    filter="url(#lineGlowFilter)"
                    opacity={glowPulse}
                />

                {/* Energy pulse traveling along the line */}
                {frame < 88 && (
                    <>
                        <circle
                            cx={pulseX}
                            cy={LINE_Y}
                            r={8}
                            fill="white"
                            opacity={0.6 * glowPulse}
                            filter="url(#pulseGlow)"
                        />
                        <circle
                            cx={pulseX}
                            cy={LINE_Y}
                            r={3}
                            fill="white"
                            opacity={0.9}
                        />
                        {/* Pulse trail */}
                        {Array.from({ length: 5 }, (_, i) => {
                            const trailX = pulseX - (i + 1) * 12;
                            if (trailX < PADDING_X) return null;
                            const trailOpacity = interpolate(i, [0, 4], [0.4, 0]);
                            return (
                                <circle
                                    key={`trail-${i}`}
                                    cx={trailX}
                                    cy={LINE_Y}
                                    r={interpolate(i, [0, 4], [4, 1])}
                                    fill="white"
                                    opacity={trailOpacity * glowPulse}
                                    filter="url(#lineGlowFilter)"
                                />
                            );
                        })}
                    </>
                )}

                {/* Pipeline nodes */}
                {NODES.map((node, i) => {
                    // Spring-based activation
                    const activationSpring = spring({
                        frame: Math.max(0, frame - node.activateAt),
                        fps,
                        config: {
                            damping: 12,
                            stiffness: 80,
                            mass: 0.6,
                        },
                    });

                    // Completion spring
                    const completionSpring = spring({
                        frame: Math.max(0, frame - node.completeAt),
                        fps,
                        config: {
                            damping: 15,
                            stiffness: 60,
                            mass: 0.5,
                        },
                    });

                    const isActive = frame >= node.activateAt;
                    const isComplete = frame >= node.completeAt;

                    // Node scale with overshoot from spring
                    const nodeScale = interpolate(activationSpring, [0, 1], [0.6, 1]);

                    // Color transition: inactive -> cyan (active) -> gold (complete)
                    const activeR = interpolate(completionSpring, [0, 1], [0, 198]);
                    const activeG = interpolate(completionSpring, [0, 1], [229, 166]);
                    const activeB = interpolate(completionSpring, [0, 1], [160, 100]);
                    const nodeColor = isActive
                        ? `rgb(${Math.round(activeR)}, ${Math.round(activeG)}, ${Math.round(activeB)})`
                        : COLORS.inactive;

                    // Inner fill opacity
                    const fillOpacity = interpolate(activationSpring, [0, 1], [0, 0.25]);

                    // Glow radius when active
                    const glowRadius = isActive ? 12 * activationSpring * glowPulse : 0;

                    // Label opacity
                    const labelOpacity = spring({
                        frame: Math.max(0, frame - node.activateAt - 5),
                        fps,
                        config: { damping: 20, stiffness: 50 },
                    });

                    // Checkmark for completed nodes
                    const checkOpacity = interpolate(completionSpring, [0, 1], [0, 1]);

                    return (
                        <React.Fragment key={`node-${i}`}>
                            {/* Ambient glow behind node */}
                            {isActive && (
                                <circle
                                    cx={node.x}
                                    cy={LINE_Y}
                                    r={NODE_RADIUS + glowRadius}
                                    fill={nodeColor}
                                    opacity={0.15 * activationSpring}
                                    filter="url(#nodeGlow)"
                                />
                            )}

                            {/* Node outer ring */}
                            <circle
                                cx={node.x}
                                cy={LINE_Y}
                                r={NODE_RADIUS * nodeScale}
                                fill={`rgba(12, 12, 18, ${fillOpacity + 0.8})`}
                                stroke={nodeColor}
                                strokeWidth={isActive ? 2.5 : 1}
                                filter={isActive ? "url(#nodeGlow)" : undefined}
                            />

                            {/* Inner fill circle */}
                            {isActive && (
                                <circle
                                    cx={node.x}
                                    cy={LINE_Y}
                                    r={(NODE_RADIUS - 4) * completionSpring}
                                    fill={nodeColor}
                                    opacity={0.3 + completionSpring * 0.4}
                                />
                            )}

                            {/* Checkmark for completed nodes */}
                            {isComplete && (
                                <path
                                    d={`M ${node.x - 5} ${LINE_Y} L ${node.x - 1} ${LINE_Y + 4} L ${node.x + 6} ${LINE_Y - 4}`}
                                    fill="none"
                                    stroke="white"
                                    strokeWidth={2}
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    opacity={checkOpacity}
                                />
                            )}

                            {/* Label */}
                            <text
                                x={node.x}
                                y={LINE_Y + NODE_RADIUS + 16}
                                textAnchor="middle"
                                fontSize={11}
                                fontFamily="system-ui, -apple-system, sans-serif"
                                fontWeight={isComplete ? 600 : 400}
                                fill={isActive ? nodeColor : "rgba(255,255,255,0.3)"}
                                opacity={isActive ? labelOpacity : 0.4}
                                letterSpacing="0.03em"
                            >
                                {node.label}
                            </text>
                        </React.Fragment>
                    );
                })}
            </svg>
        </AbsoluteFill>
    );
};
