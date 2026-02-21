import {
    AbsoluteFill,
    useCurrentFrame,
    useVideoConfig,
    interpolate,
    spring,
} from "remotion";
import React from "react";

const COLORS = {
    gold: "#c6a664",
    goldBright: "#e5c98d",
    cyan: "#00e5a0",
    cardBg: "rgba(12, 12, 18, 0.7)",
    cardBgSolid: "rgba(12, 12, 18, 0.9)",
};

const CARD_WIDTH = 360;
const CARD_HEIGHT = 460;
const BORDER_RADIUS = 16;

export const CardReveal: React.FC = () => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();

    // Card slide-up with spring physics (overshoot)
    const slideSpring = spring({
        frame,
        fps,
        config: {
            damping: 10,
            stiffness: 80,
            mass: 0.8,
        },
    });

    const cardY = interpolate(slideSpring, [0, 1], [500, 0]);
    const cardOpacity = interpolate(slideSpring, [0, 0.3], [0, 1], {
        extrapolateRight: "clamp",
    });

    // Border illumination sweep progress (clockwise around perimeter)
    const borderSweepDelay = 3;
    const borderSweepSpring = spring({
        frame: Math.max(0, frame - borderSweepDelay),
        fps,
        config: {
            damping: 25,
            stiffness: 40,
            mass: 0.6,
        },
    });

    // Total perimeter for sweep calculation
    const perimeter = 2 * (CARD_WIDTH + CARD_HEIGHT - 4 * BORDER_RADIUS) + 2 * Math.PI * BORDER_RADIUS;
    const sweepLength = perimeter * borderSweepSpring;

    // Border glow color transition: gold -> cyan
    const borderR = interpolate(borderSweepSpring, [0, 1], [198, 0]);
    const borderG = interpolate(borderSweepSpring, [0, 1], [166, 229]);
    const borderB = interpolate(borderSweepSpring, [0, 1], [100, 160]);
    const borderColor = `rgb(${Math.round(borderR)}, ${Math.round(borderG)}, ${Math.round(borderB)})`;

    // Content staggered fade-in
    const contentItems = [
        { delay: 8, type: "icon" as const },
        { delay: 11, type: "title" as const },
        { delay: 14, type: "subtitle" as const },
        { delay: 17, type: "divider" as const },
        { delay: 20, type: "body1" as const },
        { delay: 23, type: "body2" as const },
        { delay: 26, type: "button" as const },
    ];

    // Glass reflection sweep
    const reflectionX = interpolate(frame, [5, 25], [-50, 150], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
    });

    // Ambient glow behind card
    const ambientGlow = interpolate(slideSpring, [0.5, 1], [0, 0.3], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
    });

    return (
        <AbsoluteFill
            style={{
                backgroundColor: "#000000",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
            }}
        >
            {/* Ambient glow behind card */}
            <div
                style={{
                    position: "absolute",
                    width: CARD_WIDTH * 1.5,
                    height: CARD_HEIGHT * 1.2,
                    borderRadius: "50%",
                    background: `radial-gradient(ellipse, ${COLORS.gold}33, transparent 70%)`,
                    filter: "blur(40px)",
                    opacity: ambientGlow,
                    transform: `translateY(${cardY * 0.3}px)`,
                }}
            />

            {/* Card container */}
            <div
                style={{
                    position: "relative",
                    width: CARD_WIDTH,
                    height: CARD_HEIGHT,
                    transform: `translateY(${cardY}px)`,
                    opacity: cardOpacity,
                }}
            >
                {/* SVG border illumination */}
                <svg
                    style={{
                        position: "absolute",
                        top: -2,
                        left: -2,
                        width: CARD_WIDTH + 4,
                        height: CARD_HEIGHT + 4,
                        pointerEvents: "none",
                    }}
                    viewBox={`0 0 ${CARD_WIDTH + 4} ${CARD_HEIGHT + 4}`}
                >
                    <defs>
                        <filter id="borderGlow">
                            <feGaussianBlur stdDeviation="3" result="blur" />
                            <feMerge>
                                <feMergeNode in="blur" />
                                <feMergeNode in="blur" />
                                <feMergeNode in="SourceGraphic" />
                            </feMerge>
                        </filter>
                    </defs>

                    {/* Dim base border */}
                    <rect
                        x={2}
                        y={2}
                        width={CARD_WIDTH}
                        height={CARD_HEIGHT}
                        rx={BORDER_RADIUS}
                        ry={BORDER_RADIUS}
                        fill="none"
                        stroke="rgba(198, 166, 100, 0.1)"
                        strokeWidth={1}
                    />

                    {/* Illuminated border sweep */}
                    <rect
                        x={2}
                        y={2}
                        width={CARD_WIDTH}
                        height={CARD_HEIGHT}
                        rx={BORDER_RADIUS}
                        ry={BORDER_RADIUS}
                        fill="none"
                        stroke={borderColor}
                        strokeWidth={2}
                        strokeDasharray={`${sweepLength} ${perimeter}`}
                        strokeDashoffset={0}
                        filter="url(#borderGlow)"
                        opacity={0.8}
                    />
                </svg>

                {/* Glass card background */}
                <div
                    style={{
                        position: "absolute",
                        inset: 0,
                        borderRadius: BORDER_RADIUS,
                        backgroundColor: COLORS.cardBg,
                        backdropFilter: "blur(20px)",
                        overflow: "hidden",
                    }}
                >
                    {/* Glass reflection sweep */}
                    <div
                        style={{
                            position: "absolute",
                            top: 0,
                            left: `${reflectionX}%`,
                            width: "30%",
                            height: "100%",
                            background:
                                "linear-gradient(90deg, transparent, rgba(255,255,255,0.03), transparent)",
                            transform: "skewX(-15deg)",
                        }}
                    />

                    {/* Inner gradient overlay */}
                    <div
                        style={{
                            position: "absolute",
                            inset: 0,
                            background:
                                "linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 30%, rgba(0,0,0,0.2) 100%)",
                            borderRadius: BORDER_RADIUS,
                        }}
                    />
                </div>

                {/* Content container */}
                <div
                    style={{
                        position: "relative",
                        padding: 32,
                        display: "flex",
                        flexDirection: "column",
                        height: "100%",
                        boxSizing: "border-box",
                    }}
                >
                    {contentItems.map((item, i) => {
                        const itemSpring = spring({
                            frame: Math.max(0, frame - item.delay),
                            fps,
                            config: {
                                damping: 15,
                                stiffness: 60,
                                mass: 0.5,
                            },
                        });

                        const itemOpacity = itemSpring;
                        const itemY = interpolate(itemSpring, [0, 1], [20, 0]);

                        if (item.type === "icon") {
                            return (
                                <div
                                    key={i}
                                    style={{
                                        opacity: itemOpacity,
                                        transform: `translateY(${itemY}px)`,
                                        marginBottom: 20,
                                    }}
                                >
                                    <div
                                        style={{
                                            width: 48,
                                            height: 48,
                                            borderRadius: 12,
                                            background: `linear-gradient(135deg, ${COLORS.gold}33, ${COLORS.cyan}22)`,
                                            border: `1px solid ${COLORS.gold}44`,
                                            display: "flex",
                                            alignItems: "center",
                                            justifyContent: "center",
                                        }}
                                    >
                                        <svg width={24} height={24} viewBox="0 0 24 24" fill="none">
                                            <path
                                                d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"
                                                fill={COLORS.gold}
                                                opacity={0.8}
                                            />
                                        </svg>
                                    </div>
                                </div>
                            );
                        }

                        if (item.type === "title") {
                            return (
                                <div
                                    key={i}
                                    style={{
                                        opacity: itemOpacity,
                                        transform: `translateY(${itemY}px)`,
                                        fontFamily: "system-ui, -apple-system, sans-serif",
                                        fontSize: 22,
                                        fontWeight: 700,
                                        color: "#ffffff",
                                        letterSpacing: "-0.01em",
                                        marginBottom: 8,
                                    }}
                                >
                                    Premium Feature
                                </div>
                            );
                        }

                        if (item.type === "subtitle") {
                            return (
                                <div
                                    key={i}
                                    style={{
                                        opacity: itemOpacity,
                                        transform: `translateY(${itemY}px)`,
                                        fontFamily: "system-ui, -apple-system, sans-serif",
                                        fontSize: 13,
                                        color: "rgba(255,255,255,0.5)",
                                        marginBottom: 20,
                                        lineHeight: 1.4,
                                    }}
                                >
                                    Cinematic AI-powered generation
                                </div>
                            );
                        }

                        if (item.type === "divider") {
                            return (
                                <div
                                    key={i}
                                    style={{
                                        opacity: itemOpacity,
                                        transform: `translateY(${itemY}px) scaleX(${itemSpring})`,
                                        height: 1,
                                        background: `linear-gradient(90deg, transparent, ${COLORS.gold}44, transparent)`,
                                        marginBottom: 20,
                                        transformOrigin: "left center",
                                    }}
                                />
                            );
                        }

                        if (item.type === "body1" || item.type === "body2") {
                            return (
                                <div
                                    key={i}
                                    style={{
                                        opacity: itemOpacity,
                                        transform: `translateY(${itemY}px)`,
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 10,
                                        marginBottom: item.type === "body1" ? 12 : 0,
                                    }}
                                >
                                    <div
                                        style={{
                                            width: 6,
                                            height: 6,
                                            borderRadius: "50%",
                                            backgroundColor: COLORS.cyan,
                                            opacity: 0.7,
                                            boxShadow: `0 0 8px ${COLORS.cyan}88`,
                                        }}
                                    />
                                    <div
                                        style={{
                                            fontFamily: "system-ui, -apple-system, sans-serif",
                                            fontSize: 13,
                                            color: "rgba(255,255,255,0.6)",
                                        }}
                                    >
                                        {item.type === "body1"
                                            ? "Real-time video rendering"
                                            : "Automated pipeline flow"}
                                    </div>
                                </div>
                            );
                        }

                        if (item.type === "button") {
                            return (
                                <div
                                    key={i}
                                    style={{
                                        opacity: itemOpacity,
                                        transform: `translateY(${itemY}px)`,
                                        marginTop: "auto",
                                    }}
                                >
                                    <div
                                        style={{
                                            padding: "12px 24px",
                                            borderRadius: 10,
                                            background: `linear-gradient(135deg, ${COLORS.gold}, ${COLORS.goldBright})`,
                                            color: "#0c0c12",
                                            fontFamily: "system-ui, -apple-system, sans-serif",
                                            fontSize: 14,
                                            fontWeight: 600,
                                            textAlign: "center",
                                            letterSpacing: "0.01em",
                                            boxShadow: `0 4px 20px ${COLORS.gold}44, 0 0 40px ${COLORS.gold}22`,
                                        }}
                                    >
                                        Get Started
                                    </div>
                                </div>
                            );
                        }

                        return null;
                    })}
                </div>
            </div>
        </AbsoluteFill>
    );
};
