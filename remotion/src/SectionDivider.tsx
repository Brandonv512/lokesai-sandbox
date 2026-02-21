import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import React from "react";

export const SectionDivider: React.FC = () => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();

    const lineProgress = spring({
        frame,
        fps,
        config: { damping: 25, stiffness: 60, mass: 0.5 },
    });

    const glowIntensity = interpolate(
        Math.sin(frame / fps * 3),
        [-1, 1],
        [0.3, 0.8]
    );

    const shimmerX = interpolate(frame, [0, 30], [-10, 110], {
        extrapolateRight: "clamp",
    });

    return (
        <AbsoluteFill
            style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "#000000",
            }}
        >
            <svg width="100%" height="4" viewBox="0 0 1000 4">
                <defs>
                    <linearGradient id="goldLine" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="transparent" />
                        <stop offset="20%" stopColor="#c6a664" />
                        <stop offset="50%" stopColor="#e5c98d" />
                        <stop offset="80%" stopColor="#c6a664" />
                        <stop offset="100%" stopColor="transparent" />
                    </linearGradient>
                    <linearGradient id="shimmer" x1={`${shimmerX - 10}%`} y1="0%" x2={`${shimmerX + 10}%`} y2="0%">
                        <stop offset="0%" stopColor="rgba(255,255,255,0)" />
                        <stop offset="50%" stopColor={`rgba(255,255,255,${glowIntensity * 0.5})`} />
                        <stop offset="100%" stopColor="rgba(255,255,255,0)" />
                    </linearGradient>
                    <filter id="lineGlow">
                        <feGaussianBlur stdDeviation="1.5" result="blur" />
                        <feMerge>
                            <feMergeNode in="blur" />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>
                </defs>
                <line
                    x1={500 - 500 * lineProgress}
                    y1="2"
                    x2={500 + 500 * lineProgress}
                    y2="2"
                    stroke="url(#goldLine)"
                    strokeWidth="2"
                    filter="url(#lineGlow)"
                />
                <line
                    x1={500 - 500 * lineProgress}
                    y1="2"
                    x2={500 + 500 * lineProgress}
                    y2="2"
                    stroke="url(#shimmer)"
                    strokeWidth="2"
                    style={{ mixBlendMode: "overlay" }}
                />
            </svg>
        </AbsoluteFill>
    );
};
