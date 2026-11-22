import type { Shape } from "@foundry/protocol";

/** The mockup's icons, as components. Colours come in as props so an icon matches its area. */

export function ShapeIcon({ shape, color, className = "ic" }: { shape: Shape; color: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      {shape === "circle" && <><circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeWidth="2" /><circle cx="8" cy="8" r="2.6" fill={color} /></>}
      {shape === "square" && <><rect x="2" y="2" width="12" height="12" fill="none" stroke={color} strokeWidth="2" /><rect x="5.5" y="5.5" width="5" height="5" fill={color} /></>}
      {shape === "triangle" && <><polygon points="8,1.5 14.6,13.5 1.4,13.5" fill="none" stroke={color} strokeWidth="1.8" /><polygon points="8,6.5 10.6,11.3 5.4,11.3" fill={color} /></>}
      {shape === "hex" && <><polygon points="8,1 14.1,4.5 14.1,11.5 8,15 1.9,11.5 1.9,4.5" fill="none" stroke={color} strokeWidth="1.8" /><circle cx="8" cy="8" r="2.4" fill={color} /></>}
    </svg>
  );
}

export const BotIcon = ({ color }: { color: string }) => (
  <svg className="ic" viewBox="0 0 16 16" aria-hidden="true"><polygon points="8,3 13,8 8,13 3,8" fill={color} /></svg>
);

export const ChestIcon = ({ color }: { color: string }) => (
  <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
    <rect x="2" y="4" width="12" height="9" fill="#3a342a" stroke={color} strokeWidth="1.4" /><path d="M2 7.5h12" stroke={color} strokeWidth="1.2" />
    <rect x="7" y="6.5" width="2" height="2.5" fill={color} />
  </svg>
);

export const LotIcon = ({ color }: { color: string }) => (
  <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
    <rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke={color} strokeWidth="1.4" strokeDasharray="2.2 1.6" />
    <circle cx="8" cy="8" r="2.6" fill={color} />
  </svg>
);

/** A machine in each state, for the legend. */
export function StateIcon({ state }: { state: "working" | "needs_you" | "waiting" | "idle" | "ended" }) {
  const core = { working: "#4fc3d9", needs_you: "#ff5a4e", waiting: "#f0b44a", idle: "none", ended: "#3b3e44" }[state];
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true" opacity={state === "ended" ? 0.6 : 1}>
      <circle cx="8" cy="8" r="6.2" fill="#202227" stroke="#4fc3d9" strokeWidth="1.6" strokeOpacity={state === "ended" ? 0.4 : 1} />
      <circle cx="8" cy="8" r="3.4" fill={core} stroke={state === "idle" ? "#4fc3d9" : "none"} strokeOpacity=".6" />
      {state === "working" && <path d="M10.9 6.6a3.4 3.4 0 0 1 0 2.8" stroke="#202227" strokeWidth="1.6" fill="none" />}
    </svg>
  );
}

export const WarnGlyph = ({ color }: { color: string }) => (
  <svg className="glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5L22.5 21h-21z" fill={color} /><path d="M12 9v6M12 17.2v1.6" stroke="#fff" strokeWidth="2.4" /></svg>
);

export const YourMoveGlyph = ({ color }: { color: string }) => (
  <svg className="glyph" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9.5" fill="none" stroke={color} strokeWidth="2.2" /><path d="M10 7.5l5 4.5-5 4.5z" fill={color} />
  </svg>
);
