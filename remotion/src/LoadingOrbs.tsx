import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import React from "react";

export const LoadingOrbs: React.FC = () => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const time = frame / fps;

    const orbColors = [
        "rgba(198, 166, 100, 0.06)",
        "rgba(229, 201, 141, 0.04)",
        "rgba(2, 75, 85, 0.07)",
        "rgba(198, 166, 100, 0.035)",
        "rgba(99, 102, 241, 0.04)",
    ];

    function seededRandom(seed: number) {
        const x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    }

    const orbs = React.useMemo(() => {
        return Array.from({ length: 5 }, (_, i) => ({
            x: seededRandom(42 + i * 17) * 80 + 10,
            y: seededRandom(42 + i * 23) * 80 + 10,
            size: 200 + seededRandom(42 + i * 31) * 400,
            color: orbColors[i],
            speed: 0.2 + seededRandom(42 + i * 41) * 0.4,
            phase: seededRandom(42 + i * 53) * Math.PI * 2,
        }));
    }, []);

    return (
        <AbsoluteFill style={{ backgroundColor: "#000000", overflow: "hidden" }}>
            {orbs.map((orb, i) => {
                const xOffset = Math.sin(time * orb.speed + orb.phase) * 30;
                const yOffset = Math.cos(time * orb.speed * 0.7 + orb.phase) * 20;
                const scaleBreath = interpolate(
                    Math.sin(time * orb.speed * 0.5 + orb.phase),
                    [-1, 1],
                    [0.85, 1.15]
                );

                return (
                    <div
                        key={i}
                        style={{
                            position: "absolute",
                            left: `${orb.x + xOffset}%`,
                            top: `${orb.y + yOffset}%`,
                            width: orb.size * scaleBreath,
                            height: orb.size * scaleBreath,
                            borderRadius: "50%",
                            background: `radial-gradient(circle, ${orb.color}, transparent 70%)`,
                            filter: `blur(${orb.size * 0.3}px)`,
                            transform: `translate(-50%, -50%)`,
                            willChange: "transform",
                        }}
                    />
                );
            })}
        </AbsoluteFill>
    );
};
