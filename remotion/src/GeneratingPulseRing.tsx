import {
    AbsoluteFill,
    useCurrentFrame,
    useVideoConfig,
    interpolate,
    spring,
} from "remotion";
import React from "react";

const RING_RADIUS = 200;
const RING_STROKE = 4;
const PARTICLE_COUNT = 12;
const COLORS = {
    cyan: "#00e5a0",
    emerald: "#10b981",
    gold: "#c6a664",
};

interface Particle {
    angleOffset: number;
    size: number;
    speed: number;
    orbitRadius: number;
    blurAmount: number;
}

function seededRandom(seed: number): number {
    const x = Math.sin(seed * 127.1 + seed * 311.7) * 43758.5453;
    return x - Math.floor(x);
}

export const GeneratingPulseRing: React.FC = () => {
    const frame = useCurrentFrame();
    const { fps, durationInFrames } = useVideoConfig();
    const loopProgress = (frame % durationInFrames) / durationInFrames;
    const time = frame / fps;

    // Ring breathing/pulsing scale
    const breathe = interpolate(
        Math.sin(time * Math.PI * 2 * 0.5),
        [-1, 1],
        [0.94, 1.06]
    );

    // Conic gradient rotation angle in degrees
    const rotationDeg = loopProgress * 360;

    // Color transition through the loop cycle
    const colorPhase = loopProgress;
    const r1 = interpolate(colorPhase, [0, 0.33, 0.66, 1], [0, 16, 198, 0]);
    const g1 = interpolate(colorPhase, [0, 0.33, 0.66, 1], [229, 185, 166, 229]);
    const b1 = interpolate(colorPhase, [0, 0.33, 0.66, 1], [160, 129, 100, 160]);
    const r2 = interpolate(colorPhase, [0, 0.33, 0.66, 1], [16, 198, 0, 16]);
    const g2 = interpolate(colorPhase, [0, 0.33, 0.66, 1], [185, 166, 229, 185]);
    const b2 = interpolate(colorPhase, [0, 0.33, 0.66, 1], [129, 100, 160, 129]);

    const primaryColor = `rgb(${Math.round(r1)}, ${Math.round(g1)}, ${Math.round(b1)})`;
    const secondaryColor = `rgb(${Math.round(r2)}, ${Math.round(g2)}, ${Math.round(b2)})`;

    // Ring glow intensity pulsing
    const glowIntensity = interpolate(
        Math.sin(time * Math.PI * 2 * 1.5),
        [-1, 1],
        [0.4, 1.0]
    );

    // Generate particles with seeded randomness
    const particles: Particle[] = React.useMemo(
        () =>
            Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
                angleOffset: (i / PARTICLE_COUNT) * Math.PI * 2,
                size: 3 + seededRandom(i * 7 + 1) * 5,
                speed: 0.6 + seededRandom(i * 13 + 3) * 0.8,
                orbitRadius: RING_RADIUS - 10 + seededRandom(i * 19 + 5) * 20,
                blurAmount: 1 + seededRandom(i * 23 + 7) * 3,
            })),
        []
    );

    const cx = 300;
    const cy = 300;
    const circumference = 2 * Math.PI * RING_RADIUS;

    // Varying opacity segments for the ring
    const opacitySegments = 8;
    const ringSegments = Array.from({ length: opacitySegments }, (_, i) => {
        const segAngle = (i / opacitySegments) * 360;
        const adjustedAngle = (segAngle + rotationDeg) % 360;
        const segOpacity = interpolate(
            Math.sin(((adjustedAngle / 360) * Math.PI * 2) + time * 2),
            [-1, 1],
            [0.15, 0.9]
        );
        return { angle: segAngle, opacity: segOpacity };
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
            {/* Ambient glow behind the ring */}
            <div
                style={{
                    position: "absolute",
                    width: RING_RADIUS * 2.5,
                    height: RING_RADIUS * 2.5,
                    borderRadius: "50%",
                    background: `radial-gradient(circle, ${primaryColor}22, ${secondaryColor}11, transparent 70%)`,
                    filter: `blur(60px)`,
                    transform: `scale(${breathe})`,
                }}
            />

            {/* SVG ring with conic gradient simulation */}
            <svg
                width={600}
                height={600}
                viewBox="0 0 600 600"
                style={{
                    position: "absolute",
                    transform: `scale(${breathe})`,
                }}
            >
                <defs>
                    {/* Multiple gradient segments to simulate conic gradient rotation */}
                    {ringSegments.map((seg, i) => {
                        const nextSeg = ringSegments[(i + 1) % opacitySegments];
                        return (
                            <linearGradient
                                key={`grad-${i}`}
                                id={`ringGrad${i}`}
                                gradientUnits="userSpaceOnUse"
                                x1={cx + Math.cos((seg.angle * Math.PI) / 180) * RING_RADIUS}
                                y1={cy + Math.sin((seg.angle * Math.PI) / 180) * RING_RADIUS}
                                x2={cx + Math.cos((nextSeg.angle * Math.PI) / 180) * RING_RADIUS}
                                y2={cy + Math.sin((nextSeg.angle * Math.PI) / 180) * RING_RADIUS}
                            >
                                <stop offset="0%" stopColor={primaryColor} stopOpacity={seg.opacity} />
                                <stop offset="100%" stopColor={secondaryColor} stopOpacity={nextSeg.opacity} />
                            </linearGradient>
                        );
                    })}

                    <filter id="ringGlow">
                        <feGaussianBlur stdDeviation={3 * glowIntensity} result="blur" />
                        <feMerge>
                            <feMergeNode in="blur" />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>

                    <filter id="particleGlow">
                        <feGaussianBlur stdDeviation="2" result="blur" />
                        <feMerge>
                            <feMergeNode in="blur" />
                            <feMergeNode in="blur" />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>
                </defs>

                {/* Main ring drawn as arc segments */}
                {ringSegments.map((seg, i) => {
                    const startAngle = ((seg.angle + rotationDeg) * Math.PI) / 180;
                    const endAngle = (((ringSegments[(i + 1) % opacitySegments].angle) + rotationDeg) * Math.PI) / 180;
                    const x1 = cx + Math.cos(startAngle) * RING_RADIUS;
                    const y1 = cy + Math.sin(startAngle) * RING_RADIUS;
                    const x2 = cx + Math.cos(endAngle) * RING_RADIUS;
                    const y2 = cy + Math.sin(endAngle) * RING_RADIUS;

                    return (
                        <path
                            key={`arc-${i}`}
                            d={`M ${x1} ${y1} A ${RING_RADIUS} ${RING_RADIUS} 0 0 1 ${x2} ${y2}`}
                            fill="none"
                            stroke={primaryColor}
                            strokeWidth={RING_STROKE}
                            strokeLinecap="round"
                            opacity={seg.opacity * glowIntensity}
                            filter="url(#ringGlow)"
                        />
                    );
                })}

                {/* Secondary inner ring with offset rotation */}
                <circle
                    cx={cx}
                    cy={cy}
                    r={RING_RADIUS - 15}
                    fill="none"
                    stroke={secondaryColor}
                    strokeWidth={1}
                    opacity={0.15 * glowIntensity}
                    strokeDasharray={`${circumference * 0.04} ${circumference * 0.08}`}
                    strokeDashoffset={-loopProgress * circumference}
                />

                {/* Outer faint ring */}
                <circle
                    cx={cx}
                    cy={cy}
                    r={RING_RADIUS + 15}
                    fill="none"
                    stroke={primaryColor}
                    strokeWidth={0.5}
                    opacity={0.1 * glowIntensity}
                    strokeDasharray={`${circumference * 0.02} ${circumference * 0.12}`}
                    strokeDashoffset={loopProgress * circumference * 0.5}
                />

                {/* Orbiting particles */}
                {particles.map((particle, i) => {
                    const angle = particle.angleOffset + time * particle.speed * Math.PI * 2;
                    const px = cx + Math.cos(angle) * particle.orbitRadius;
                    const py = cy + Math.sin(angle) * particle.orbitRadius;

                    // Particle brightness varies with position
                    const particleOpacity = interpolate(
                        Math.sin(angle + time * 2),
                        [-1, 1],
                        [0.3, 1.0]
                    );

                    // Color alternation between cyan and gold
                    const particleColor = i % 3 === 0 ? COLORS.gold : i % 3 === 1 ? COLORS.cyan : COLORS.emerald;

                    return (
                        <React.Fragment key={`particle-${i}`}>
                            {/* Particle glow halo */}
                            <circle
                                cx={px}
                                cy={py}
                                r={particle.size * 2.5}
                                fill={particleColor}
                                opacity={particleOpacity * 0.15}
                                filter="url(#particleGlow)"
                            />
                            {/* Particle core */}
                            <circle
                                cx={px}
                                cy={py}
                                r={particle.size}
                                fill={particleColor}
                                opacity={particleOpacity * 0.9}
                                filter="url(#particleGlow)"
                            />
                        </React.Fragment>
                    );
                })}

                {/* Energy pulse traveling along the ring */}
                {(() => {
                    const pulseAngle = loopProgress * Math.PI * 2;
                    const pulseX = cx + Math.cos(pulseAngle) * RING_RADIUS;
                    const pulseY = cy + Math.sin(pulseAngle) * RING_RADIUS;
                    const pulseTrailLength = 6;

                    return Array.from({ length: pulseTrailLength }, (_, t) => {
                        const trailAngle = pulseAngle - t * 0.08;
                        const tx = cx + Math.cos(trailAngle) * RING_RADIUS;
                        const ty = cy + Math.sin(trailAngle) * RING_RADIUS;
                        const trailOpacity = interpolate(t, [0, pulseTrailLength - 1], [0.9, 0]);

                        return (
                            <circle
                                key={`pulse-${t}`}
                                cx={tx}
                                cy={ty}
                                r={interpolate(t, [0, pulseTrailLength - 1], [6, 2])}
                                fill="#ffffff"
                                opacity={trailOpacity}
                                filter="url(#particleGlow)"
                            />
                        );
                    });
                })()}
            </svg>
        </AbsoluteFill>
    );
};
