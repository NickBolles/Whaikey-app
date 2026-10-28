"use client";

import Image from "next/image";
import { useState, type ReactNode } from "react";

/**
 * A licensed remote bottle shot through the Next image optimizer: lazy (the
 * default for next/image), sized by `sizes`, and replaced by the generated
 * silhouette if the source ever 404s or times out — never a broken image.
 */
export function RemoteBottleImage({ src, width, height, fallback, className = "" }: {
  src: string;
  width: number;
  height: number;
  fallback: ReactNode;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  return (
    <span className={`relative inline-block shrink-0 overflow-hidden rounded-md ${className}`} style={{ width, height }}>
      <Image
        src={src}
        alt=""
        fill
        sizes={`${width}px`}
        loading="lazy"
        className="object-contain"
        onError={() => setFailed(true)}
        data-testid="bottle-photo"
      />
    </span>
  );
}
