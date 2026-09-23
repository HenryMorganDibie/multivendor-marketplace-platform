"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, ChevronLeft, ChevronRight, MapPin, Star } from "lucide-react";

// Icon components can't cross the server/client boundary as props (they're
// functions), so this carousel's slide content lives here rather than being
// passed in from the server-rendered homepage.
const MORE_WAYS_SLIDES = [
  { icon: Bell, title: "Stay in the loop", body: "Notifications for activity that matters." },
  { icon: Star, title: "Build your reputation", body: "Reviews help customers decide with confidence." },
  { icon: MapPin, title: "Local by design", body: "Discover and operate based on your country and location." },
];

/**
 * Horizontal snap-scroll showcase, one feature per slide -- the "glide
 * through the features" pattern from whatsapp.com/messaging, adapted to
 * Platform's own feature set rather than WhatsApp's.
 */
export default function FeatureCarousel() {
  const slides = MORE_WAYS_SLIDES;
  const trackRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const scrollToIndex = useCallback((index: number) => {
    const track = trackRef.current;
    if (!track) return;
    const slide = track.children[index] as HTMLElement | undefined;
    slide?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    // Track which slide is centered as the user swipes/scrolls, so the dots
    // and arrow disabled-state reflect an in-progress finger-drag too, not
    // just a completed programmatic scroll.
    let frame: number;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { scrollLeft, offsetWidth } = track;
        const center = scrollLeft + offsetWidth / 2;
        let closest = 0;
        let closestDistance = Infinity;
        Array.from(track.children).forEach((child, i) => {
          const el = child as HTMLElement;
          const elCenter = el.offsetLeft + el.offsetWidth / 2;
          const distance = Math.abs(elCenter - center);
          if (distance < closestDistance) {
            closestDistance = distance;
            closest = i;
          }
        });
        setActiveIndex(closest);
      });
    };

    track.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      track.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="relative">
      <div
        ref={trackRef}
        className="flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {slides.map(({ icon: Icon, title, body }) => (
          <div
            key={title}
            className="w-[85%] shrink-0 snap-center rounded-card-lg border border-hairline bg-white p-6 shadow-soft sm:w-[45%] lg:w-[31%]"
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-light">
              <Icon size={20} className="text-brand" />
            </div>
            <h3 className="mt-4 font-bold tracking-[-0.01em] text-ink">{title}</h3>
            <p className="mt-1.5 text-sm text-ink-secondary">{body}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 flex items-center justify-center gap-4">
        <button
          type="button"
          onClick={() => scrollToIndex(Math.max(0, activeIndex - 1))}
          disabled={activeIndex === 0}
          aria-label="Previous feature"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-hairline text-ink-secondary transition hover:border-brand hover:text-brand disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronLeft size={16} />
        </button>

        <div className="flex items-center gap-2" role="tablist" aria-label="Feature slides">
          {slides.map((slide, i) => (
            <button
              key={slide.title}
              type="button"
              role="tab"
              aria-label={`Show ${slide.title}`}
              aria-selected={i === activeIndex}
              onClick={() => scrollToIndex(i)}
              className={`h-2 rounded-full transition-all ${
                i === activeIndex ? "w-6 bg-brand" : "w-2 bg-hairline-strong hover:bg-ink-tertiary"
              }`}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={() => scrollToIndex(Math.min(slides.length - 1, activeIndex + 1))}
          disabled={activeIndex === slides.length - 1}
          aria-label="Next feature"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-hairline text-ink-secondary transition hover:border-brand hover:text-brand disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
