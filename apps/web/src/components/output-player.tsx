"use client";

import { useEffect, useRef, useState } from "react";
import type { ProgramOutput } from "./api";

export function OutputPlayer({
  item,
  clean = false,
  onPlayback,
  onProgress,
}: {
  item: ProgramOutput["currentProgramItem"];
  clean?: boolean;
  onPlayback?: (event: { itemId: string; sequence: number; seconds: number }) => void;
  onProgress?: (event: { itemId: string; seconds: number }) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<{ destroy: () => void } | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const mediaUrl = item?.assetUrl;
  const itemId = item?.id;

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !itemId || !mediaUrl) return;
    let alive = true;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    element.pause();
    element.removeAttribute("src");
    element.load();
    setPlayError(null);

    const setNativeSource = () => {
      element.src = mediaUrl;
      element.load();
    };

    if (mediaUrl.includes(".m3u8") && !element.canPlayType("application/vnd.apple.mpegurl")) {
      void import("hls.js").then(({ default: Hls }) => {
        if (!alive) return;
        if (!Hls.isSupported()) {
          setPlayError("This browser can't play this stream format. A compatible media source is not available yet.");
          return;
        }
        const hls = new Hls({
          maxBufferLength: 18,
          maxMaxBufferLength: 28,
          backBufferLength: 16,
          liveSyncDurationCount: 2,
          enableWorker: true,
        });
        hlsRef.current = hls;
        hls.loadSource(mediaUrl);
        hls.attachMedia(element);
        hls.on(Hls.Events.ERROR, (_event, info) => {
          if (alive && info.fatal) setPlayError("Playback paused while the source reconnects. Try play again in a moment.");
        });
      }).catch(() => {
        if (alive) setPlayError("The stream player couldn't load. Please reload the page.");
      });
    } else {
      setNativeSource();
    }

    return () => {
      alive = false;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [itemId, mediaUrl]);

  if (!item || !mediaUrl) {
    return (
      <div className="video-placeholder">
        <div className="orb" aria-hidden="true" />
        <div className="placeholder-content">
          <span className="placeholder-icon" aria-hidden="true">✳</span>
          <h3>Waiting for the first approved scene</h3>
          <p>The browser output is ready. It will show channel media as it becomes available.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`media-stage${clean ? " clean-media-stage" : ""}`}>
      <video
        ref={videoRef}
        controls={!clean}
        playsInline
        preload="metadata"
        aria-label={`${item.kind === "subscriber_interrupt" ? "Subscriber interstitial" : "Channel story"}`}
        onPlay={() => setPlayError(null)}
        onTimeUpdate={(event) => onProgress?.({ itemId: item.id, seconds: event.currentTarget.currentTime })}
        onEnded={() => onPlayback?.({ itemId: item.id, sequence: 0, seconds: item.durationSeconds ?? 0 })}
        onError={() => setPlayError((current) => current ?? "This scene couldn't be loaded. The source can retry from the timeline.")}
      />
      {!clean && (item.kind === "subscriber_interrupt" || playError) ? (
        <div className="media-caption" aria-live="polite">
          {item.kind === "subscriber_interrupt" ? <span>✦ {item.subscriberLabel ? `A moment for ${item.subscriberLabel}` : "Subscriber moment"}</span> : null}
          {playError ? <span role="status">{playError}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
