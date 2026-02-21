import React from "react";
import { Composition } from "remotion";
import { LowkieLogoReveal } from "./LowkieLogoReveal";
import { LoadingOrbs } from "./LoadingOrbs";
import { SectionDivider } from "./SectionDivider";
import { GeneratingPulseRing } from "./GeneratingPulseRing";
import { PipelineFlow } from "./PipelineFlow";
import { CinematicBackground } from "./CinematicBackground";
import { CardReveal } from "./CardReveal";

export const RemotionRoot: React.FC = () => {
    return (
        <>
            <Composition
                id="LowkieLogoReveal"
                component={LowkieLogoReveal}
                durationInFrames={90}
                fps={30}
                width={480}
                height={200}
            />
            <Composition
                id="LoadingOrbs"
                component={LoadingOrbs}
                durationInFrames={150}
                fps={30}
                width={1920}
                height={1080}
            />
            <Composition
                id="SectionDivider"
                component={SectionDivider}
                durationInFrames={30}
                fps={30}
                width={1000}
                height={40}
            />
            <Composition
                id="GeneratingPulseRing"
                component={GeneratingPulseRing}
                durationInFrames={120}
                fps={30}
                width={600}
                height={600}
            />
            <Composition
                id="PipelineFlow"
                component={PipelineFlow}
                durationInFrames={90}
                fps={30}
                width={1200}
                height={80}
            />
            <Composition
                id="CinematicBackground"
                component={CinematicBackground}
                durationInFrames={300}
                fps={30}
                width={1920}
                height={1080}
            />
            <Composition
                id="CardReveal"
                component={CardReveal}
                durationInFrames={30}
                fps={30}
                width={400}
                height={500}
            />
        </>
    );
};
