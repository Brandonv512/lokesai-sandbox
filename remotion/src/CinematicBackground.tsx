import {
    AbsoluteFill,
    useCurrentFrame,
    useVideoConfig,
    interpolate,
} from "remotion";
import React from "react";

const COLORS = {
    gold: "#c6a664",
    goldRgba: "rgba(198, 166, 100,",
    cyan: "#00e5a0",
    cyanRgba: "rgba(0, 229, 160,",
};

function seededRandom(seed: number): number {
    const x = Math.sin(seed * 127.1 + seed * 311.7) * 43758.5453;
    return x - Math.floor(x);
}

interface FogLayer {
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
    speed: number;
    phase: number;
    depth: number;
}

interface MicroParticle {
    x: number;
    y: number;
    size: number;
    depth: number;
    driftSpeedX: number;
    driftSpeedY: number;
    phase: number;
    color: string;
    wobbleSpeed: number;
    wobbleAmount: number;
}

const FOG_LAYER_COUNT = 6;
const PARTICLE_COUNT = 80;

export const CinematicBackground: React.FC = () => {
    const frame = useCurrentFrame();
    const { fps, durationInFrames } = useVideoConfig();
    const time = frame / fps;
    const loopProgress = (frame % durationInFrames) / durationInFrames;

    // Generate fog layers with seeded randomness
    const fogLayers: FogLayer[] = React.useMemo(
        () =>
            Array.from({ length: FOG_LAYER_COUNT }, (_, i) => {
                const isGold = i % 2 === 0;
                const baseOpacity = 0.02 + seededRandom(i * 37 + 1) * 0.03;
                return {
                    x: seededRandom(i * 43 + 7) * 100,
                    y: 20 + seededRandom(i * 59 + 11) * 60,
                    width: 400 + seededRandom(i * 67 + 13) * 600,
                    height: 200 + seededRandom(i * 71 + 17) * 300,
                    color: isGold
                        ? `${COLORS.goldRgba} ${baseOpacity})`
                        : `${COLORS.cyanRgba} ${baseOpacity})`,
                    speed: 0.03 + seededRandom(i * 79 + 19) * 0.06,
                    phase: seededRandom(i * 83 + 23) * Math.PI * 2,
                    depth: 0.3 + seededRandom(i * 89 + 29) * 0.7,
                };
            }),
        []
    );

    // Generate micro particles
    const particles: MicroParticle[] = React.useMemo(
        () =>
            Array.from({ length: PARTICLE_COUNT }, (_, i) => {
                const depth = seededRandom(i * 97 + 31);
                const colorRoll = seededRandom(i * 101 + 37);
                let color: string;
                if (colorRoll < 0.35) {
                    color = `${COLORS.goldRgba} ${0.15 + depth * 0.35})`;
                } else if (colorRoll < 0.7) {
                    color = `${COLORS.cyanRgba} ${0.1 + depth * 0.3})`;
                } else {
                    color = `rgba(255, 255, 255, ${0.05 + depth * 0.2})`;
                }

                return {
                    x: seededRandom(i * 103 + 41) * 1920,
                    y: seededRandom(i * 107 + 43) * 1080,
                    size: 1 + seededRandom(i * 109 + 47) * 3,
                    depth,
                    driftSpeedX: (seededRandom(i * 113 + 53) - 0.5) * 8,
                    driftSpeedY: (seededRandom(i * 127 + 59) - 0.5) * 4 - 2,
                    phase: seededRandom(i * 131 + 61) * Math.PI * 2,
                    color,
                    wobbleSpeed: 0.3 + seededRandom(i * 137 + 67) * 1.2,
                    wobbleAmount: 5 + seededRandom(i * 139 + 71) * 20,
                };
            }),
        []
    );

    // Aurora wave parameters
    const auroraWave1 = Math.sin(time * 0.15 + 0.5) * 0.5 + 0.5;
    const auroraWave2 = Math.sin(time * 0.1 + 2.0) * 0.5 + 0.5;
    const auroraShift = time * 0.02;

    return (
        <AbsoluteFill
            style={{
                backgroundColor: "#030306",
                overflow: "hidden",
            }}
        >
            {/* Deep background gradient */}
            <div
                style={{
                    position: "absolute",
                    inset: 0,
                    background:
                        "radial-gradient(ellipse 120% 80% at 50% 40%, rgba(8, 8, 15, 1) 0%, rgba(3, 3, 6, 1) 100%)",
                }}
            />

            {/* Aurora borealis effect - Layer 1 (Gold) */}
            <div
                style={{
                    position: "absolute",
                    left: `${-20 + Math.sin(auroraShift * Math.PI * 2) * 10}%`,
                    top: `${15 + auroraWave1 * 10}%`,
                    width: "140%",
                    height: "30%",
                    background: `linear-gradient(${90 + Math.sin(time * 0.2) * 15}deg,
                        transparent 0%,
                        ${COLORS.goldRgba} ${0.015 + auroraWave1 * 0.02}) 20%,
                        ${COLORS.goldRgba} ${0.03 + auroraWave1 * 0.025}) 40%,
                        ${COLORS.cyanRgba} ${0.01 + auroraWave2 * 0.015}) 60%,
                        transparent 80%)`,
                    filter: "blur(80px)",
                    transform: `skewY(${Math.sin(time * 0.1) * 3}deg) scaleY(${0.8 + auroraWave1 * 0.4})`,
                    opacity: interpolate(
                        Math.sin(time * 0.3),
                        [-1, 1],
                        [0.4, 0.8]
                    ),
                }}
            />

            {/* Aurora borealis effect - Layer 2 (Cyan) */}
            <div
                style={{
                    position: "absolute",
                    left: `${-10 + Math.cos(auroraShift * Math.PI * 2 + 1) * 15}%`,
                    top: `${10 + auroraWave2 * 15}%`,
                    width: "130%",
                    height: "25%",
                    background: `linear-gradient(${100 + Math.cos(time * 0.15) * 20}deg,
                        transparent 0%,
                        ${COLORS.cyanRgba} ${0.01 + auroraWave2 * 0.02}) 25%,
                        ${COLORS.goldRgba} ${0.015 + auroraWave1 * 0.015}) 50%,
                        ${COLORS.cyanRgba} ${0.02 + auroraWave2 * 0.02}) 75%,
                        transparent 100%)`,
                    filter: "blur(100px)",
                    transform: `skewY(${Math.cos(time * 0.08) * -2}deg)`,
                    opacity: interpolate(
                        Math.sin(time * 0.25 + 1.5),
                        [-1, 1],
                        [0.3, 0.7]
                    ),
                }}
            />

            {/* Volumetric fog layers with depth parallax */}
            {fogLayers.map((fog, i) => {
                const parallaxMultiplier = 0.5 + fog.depth * 0.5;
                const xDrift = Math.sin(time * fog.speed + fog.phase) * 60 * parallaxMultiplier;
                const yDrift = Math.cos(time * fog.speed * 0.7 + fog.phase) * 30 * parallaxMultiplier;
                const fogOpacity = interpolate(
                    Math.sin(time * fog.speed * 2 + fog.phase),
                    [-1, 1],
                    [0.3, 1.0]
                );
                const blurAmount = 60 + (1 - fog.depth) * 80;

                return (
                    <div
                        key={`fog-${i}`}
                        style={{
                            position: "absolute",
                            left: `${fog.x + xDrift}px`,
                            top: `${(fog.y / 100) * 1080 + yDrift}px`,
                            width: fog.width,
                            height: fog.height,
                            borderRadius: "50%",
                            background: `radial-gradient(ellipse, ${fog.color}, transparent 70%)`,
                            filter: `blur(${blurAmount}px)`,
                            opacity: fogOpacity,
                            transform: `translate(-50%, -50%) scale(${0.9 + fog.depth * 0.3})`,
                        }}
                    />
                );
            })}

            {/* Floating micro-particles with varying depth */}
            {particles.map((particle, i) => {
                // Seamless loop: use loopProgress for position so particles wrap around
                const progressOffset = loopProgress * durationInFrames / fps;
                const rawX = particle.x + progressOffset * particle.driftSpeedX * 10;
                const rawY = particle.y + progressOffset * particle.driftSpeedY * 10;

                // Wrap positions for seamless looping
                const px = ((rawX % 1920) + 1920) % 1920;
                const py = ((rawY % 1080) + 1080) % 1080;

                // Wobble for slight random movement
                const wobbleX = Math.sin(time * particle.wobbleSpeed + particle.phase) * particle.wobbleAmount;
                const wobbleY = Math.cos(time * particle.wobbleSpeed * 0.8 + particle.phase + 1) * particle.wobbleAmount * 0.6;

                // Depth-based blur
                const blurLevel = interpolate(particle.depth, [0, 1], [3, 0]);

                // Twinkle effect
                const twinkle = interpolate(
                    Math.sin(time * (1.5 + particle.wobbleSpeed) + particle.phase * 3),
                    [-1, 1],
                    [0.2, 1.0]
                );

                // Depth-based parallax on wobble
                const depthScale = 0.5 + particle.depth * 0.5;

                return (
                    <div
                        key={`particle-${i}`}
                        style={{
                            position: "absolute",
                            left: px + wobbleX * depthScale,
                            top: py + wobbleY * depthScale,
                            width: particle.size * (0.5 + particle.depth * 0.5),
                            height: particle.size * (0.5 + particle.depth * 0.5),
                            borderRadius: "50%",
                            backgroundColor: particle.color,
                            filter: `blur(${blurLevel}px)`,
                            opacity: twinkle,
                            boxShadow: particle.depth > 0.7
                                ? `0 0 ${particle.size * 2}px ${particle.color}`
                                : undefined,
                        }}
                    />
                );
            })}

            {/* Subtle vignette overlay */}
            <div
                style={{
                    position: "absolute",
                    inset: 0,
                    background:
                        "radial-gradient(ellipse 70% 70% at 50% 50%, transparent 0%, rgba(0,0,0,0.6) 100%)",
                    pointerEvents: "none",
                }}
            />
        </AbsoluteFill>
    );
};
