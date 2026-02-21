import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import React from "react";

export const LowkieLogoReveal: React.FC = () => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();

    // Wave path draw animation
    const pathProgress = spring({ frame, fps, config: { damping: 30, stiffness: 40, mass: 0.8 } });

    // Secondary wave
    const secondaryProgress = spring({ frame: Math.max(0, frame - 10), fps, config: { damping: 25, stiffness: 35 } });

    // Circle draw
    const circleProgress = spring({ frame: Math.max(0, frame - 5), fps, config: { damping: 28, stiffness: 38 } });

    // Text reveal
    const textOpacity = spring({ frame: Math.max(0, frame - 20), fps, config: { damping: 20, stiffness: 50 } });
    const textY = interpolate(textOpacity, [0, 1], [15, 0]);

    // Subtitle
    const subOpacity = spring({ frame: Math.max(0, frame - 30), fps, config: { damping: 20, stiffness: 40 } });
    const subLetterSpacing = interpolate(subOpacity, [0, 1], [0.8, 0.15]);

    // Glow pulse
    const glowPulse = interpolate(Math.sin(frame / fps * 2), [-1, 1], [0.3, 0.7]);

    // Gold shimmer offset
    const shimmerOffset = interpolate(frame, [0, 90], [0, 100], { extrapolateRight: "extend" });

    return (
        <AbsoluteFill
            style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "#000000",
            }}
        >
            <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 20 }}>
                {/* Animated SVG Logo Mark */}
                <svg
                    viewBox="0 0 120 120"
                    fill="none"
                    style={{
                        width: 80,
                        height: 80,
                        filter: `drop-shadow(0 0 ${12 * glowPulse}px rgba(198,166,100,0.4))`,
                    }}
                >
                    <defs>
                        <linearGradient id="logoGold" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stopColor="#e5c98d" />
                            <stop offset="30%" stopColor="#c6a664" />
                            <stop offset="60%" stopColor="#b8923e" />
                            <stop offset="100%" stopColor="#8c7335" />
                        </linearGradient>
                        <linearGradient id="logoShine" x1={`${shimmerOffset - 20}%`} y1="0%" x2={`${shimmerOffset + 20}%`} y2="0%">
                            <stop offset="0%" stopColor="rgba(255,255,255,0)" />
                            <stop offset="50%" stopColor="rgba(255,255,255,0.4)" />
                            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
                        </linearGradient>
                        <filter id="glow">
                            <feGaussianBlur stdDeviation="2.5" result="blur" />
                            <feMerge>
                                <feMergeNode in="blur" />
                                <feMergeNode in="SourceGraphic" />
                            </feMerge>
                        </filter>
                    </defs>

                    {/* Outer circle */}
                    <circle
                        cx="60" cy="60" r="54"
                        stroke="url(#logoGold)"
                        strokeWidth="1.5"
                        fill="none"
                        strokeDasharray={`${54 * 2 * Math.PI}`}
                        strokeDashoffset={`${54 * 2 * Math.PI * (1 - circleProgress)}`}
                        opacity={0.4}
                    />

                    {/* Main wave */}
                    <path
                        d="M18 65 C30 30, 45 75, 60 50 S85 25, 102 55"
                        stroke="url(#logoGold)"
                        strokeWidth="5"
                        strokeLinecap="round"
                        fill="none"
                        filter="url(#glow)"
                        strokeDasharray="200"
                        strokeDashoffset={200 * (1 - pathProgress)}
                    />

                    {/* Secondary wave */}
                    <path
                        d="M22 78 C38 58, 55 85, 72 62 S92 45, 98 68"
                        stroke="url(#logoGold)"
                        strokeWidth="2"
                        strokeLinecap="round"
                        fill="none"
                        opacity={secondaryProgress * 0.5}
                        strokeDasharray="180"
                        strokeDashoffset={180 * (1 - secondaryProgress)}
                    />

                    {/* Shimmer sweep */}
                    <path
                        d="M18 65 C30 30, 45 75, 60 50 S85 25, 102 55"
                        stroke="url(#logoShine)"
                        strokeWidth="5"
                        strokeLinecap="round"
                        fill="none"
                        strokeDasharray="200"
                        strokeDashoffset={200 * (1 - pathProgress)}
                        style={{ mixBlendMode: "overlay" }}
                    />
                </svg>

                {/* Text */}
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <div
                        style={{
                            fontFamily: "system-ui, sans-serif",
                            fontWeight: 800,
                            fontSize: 36,
                            letterSpacing: "-0.02em",
                            lineHeight: 1,
                            background: "linear-gradient(135deg, #e5c98d 0%, #c6a664 40%, #fff 100%)",
                            WebkitBackgroundClip: "text",
                            WebkitTextFillColor: "transparent",
                            opacity: textOpacity,
                            transform: `translateY(${textY}px)`,
                            filter: `drop-shadow(0 0 8px rgba(198,166,100,${glowPulse * 0.3}))`,
                        }}
                    >
                        Lowkie AI
                    </div>
                    <div
                        style={{
                            fontFamily: "monospace",
                            fontSize: 10,
                            letterSpacing: `${subLetterSpacing}em`,
                            textTransform: "uppercase",
                            color: `rgba(198, 166, 100, ${subOpacity * 0.5})`,
                            transform: `translateY(${textY}px)`,
                        }}
                    >
                        Video Automation Engine
                    </div>
                </div>
            </div>
        </AbsoluteFill>
    );
};
