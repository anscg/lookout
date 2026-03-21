import React, { useEffect, useState } from "react";
import { createPlayer } from "@videojs/react";
import { VideoSkin, Video, videoFeatures } from "@videojs/react/video";
import "@videojs/react/video/skin.css";
import "./VideoPlayer.css";

interface VideoPlayerProps {
  src: string;
}

const Player = createPlayer({ features: videoFeatures });

export function VideoPlayer({ src }: VideoPlayerProps) {
  const [platform, setPlatform] = useState("");

  useEffect(() => {
    if (typeof navigator !== "undefined") {
      const ua = navigator.userAgent.toLowerCase();
      if (ua.includes("linux") && !ua.includes("android")) {
        setPlatform("linux");
      } else if (ua.includes("win")) {
        setPlatform("windows");
      } else if (ua.includes("mac")) {
        setPlatform("mac");
      }
    }
  }, []);

  return (
    <div className={`collapse-video-player platform-${platform}`} style={{ width: "100%", height: "100%", display: "flex", "--media-border-radius": "8px", "--media-video-border-radius": "8px" } as React.CSSProperties}>
      <Player.Provider>
        <VideoSkin style={{ width: "100%", height: "100%" }}>
          <Video src={src} muted playsInline autoPlay={false} />
        </VideoSkin>
      </Player.Provider>
    </div>
  );
}
