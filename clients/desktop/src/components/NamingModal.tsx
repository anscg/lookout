import React, { useRef, useEffect, useState, useCallback } from "react";
import { motion } from "motion/react";
import { Button, Card, colors, spacing, radii, fontSize, fontWeight } from "@lookout/react";

interface NamingModalProps {
  loading: boolean;
  onConfirm: (name: string | null) => void;
  /** Stop, then open the editor before anything is published. Editing is
   *  offered HERE, not after the timelapse goes out: `complete` is when
   *  programs consume a session (heartbeats, tracked time, video), so the
   *  data has to be final the first time they see it. */
  onEditAndSave: (name: string | null) => void;
  onResume: () => void;
}

export function NamingModal({ loading, onConfirm, onEditAndSave, onResume }: NamingModalProps) {
  const [name, setName] = useState("");
  const [choice, setChoice] = useState<"stop" | "edit" | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus the input when modal opens
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  return (
    <div data-lookout-overlay="" style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: navigator.userAgent.toLowerCase().includes("windows") ? "linear-gradient(to bottom, transparent 0%, var(--color-modal-backdrop, rgba(0,0,0,0.8)) 100%)" : "var(--color-modal-backdrop, rgba(0,0,0,0.8))",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 9999, padding: spacing.xl,
    }}>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          y: { type: "spring", stiffness: 420, damping: 34, mass: 0.7 },
          opacity: { duration: 0.16, ease: "easeOut" },
        }}
        style={{ width: "100%", maxWidth: 400 }}
      >
        <Card padding={spacing.xxl} style={{ width: "100%", height: "auto", background: "var(--color-bg-panel)", textAlign: "center", boxShadow: "0 10px 40px rgba(0,0,0,0.5)" }}>
        <h3 style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.text.primary, margin: 0, marginBottom: spacing.sm }}>
          Name your timelapse
        </h3>
        <p style={{ fontSize: fontSize.md, color: colors.text.secondary, margin: 0, marginBottom: spacing.lg }}>
          Give it a name, or skip to use the default.
        </p>
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !loading) onConfirm(name);
          }}
          placeholder="My timelapse"
          maxLength={255}
          disabled={loading}
          style={{
            width: "100%",
            padding: `${spacing.md}px ${spacing.lg}px`,
            fontSize: fontSize.lg,
            fontWeight: fontWeight.medium,
            color: colors.text.primary,
            background: colors.bg.sunken,
            border: `1px solid ${colors.border.default}`,
            borderRadius: radii.md,
            outline: "none",
            boxSizing: "border-box",
            marginBottom: spacing.lg,
            opacity: loading ? 0.5 : 1,
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: spacing.sm }}>
          <Button
            variant="primary"
            size="lg"
            fullWidth
            loading={loading && choice === "edit"}
            disabled={loading && choice !== "edit"}
            onClick={() => {
              setChoice("edit");
              onEditAndSave(name);
            }}
          >
            Edit &amp; Save
          </Button>
          <div style={{ display: "flex", gap: spacing.md }}>
            <Button
              variant="secondary"
              size="lg"
              fullWidth
              loading={loading && choice === "stop"}
              disabled={loading && choice !== "stop"}
              onClick={() => {
                setChoice("stop");
                onConfirm(name);
              }}
            >
              Save &amp; Stop
            </Button>
            <Button
              variant="success"
              size="lg"
              fullWidth
              disabled={loading}
              onClick={onResume}
            >
              Resume
            </Button>
          </div>
        </div>
        </Card>
      </motion.div>
    </div>
  );
}
