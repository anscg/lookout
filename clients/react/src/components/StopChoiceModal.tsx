import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Overlay } from "../ui/Overlay.js";
import { colors, fontSize, fontWeight, radii, spacing } from "../ui/theme.js";

export interface StopChoiceModalProps {
  /** Keep recording — the user hit Stop by accident or changed their mind. */
  onResume: () => void;
  /** Stop and publish as recorded. */
  onStopAndSave: (name: string | null) => void;
  /** Stop, then review and cut before anything is published. Omit to hide
   *  the option (programs that don't want an editing step). */
  onEditAndSave?: (name: string | null) => void;
  /** Show a name field (the desktop app names timelapses at stop time). */
  withName?: boolean;
  loading?: boolean;
}

/**
 * The stop confirmation. Editing is offered HERE rather than after the
 * timelapse is published, because publishing is the point at which
 * programs consume a session — its heartbeats, its tracked time, its
 * video. Once that's happened, quietly changing the numbers underneath
 * them isn't an edit, it's a rewrite of something already acted on.
 */
export function StopChoiceModal({
  onResume,
  onStopAndSave,
  onEditAndSave,
  withName = false,
  loading = false,
}: StopChoiceModalProps) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [choice, setChoice] = useState<"stop" | "edit" | null>(null);

  useEffect(() => {
    if (withName) setTimeout(() => inputRef.current?.focus(), 50);
  }, [withName]);

  const value = () => name.trim() || null;

  return (
    <Overlay label="Finish this timelapse?" width={420}>
      <div style={{ overflow: "auto" }}>
        <Card
          padding={spacing.xxl}
          style={{
            width: "100%",
            height: "auto",
            background: "transparent",
            border: "none",
          }}
        >
          <h3
            style={{
              fontSize: fontSize.xl,
              fontWeight: fontWeight.bold,
              color: colors.text.primary,
              margin: 0,
              marginBottom: spacing.sm,
            }}
          >
            Finish this timelapse?
          </h3>
          <p
            style={{
              fontSize: fontSize.md,
              color: colors.text.secondary,
              margin: 0,
              marginBottom: spacing.lg,
            }}
          >
            {onEditAndSave
              ? "Save it as recorded, or review it first and cut out anything you'd rather not share."
              : "This ends the recording and compiles your timelapse."}
          </p>

          {withName && (
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !loading) {
                  setChoice("stop");
                  onStopAndSave(value());
                }
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
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: spacing.sm }}>
            {onEditAndSave && (
              <Button
                variant="primary"
                size="lg"
                fullWidth
                loading={loading && choice === "edit"}
                disabled={loading && choice !== "edit"}
                onClick={() => {
                  setChoice("edit");
                  onEditAndSave(value());
                }}
              >
                Edit &amp; save
              </Button>
            )}
            <Button
              variant={onEditAndSave ? "secondary" : "primary"}
              size="lg"
              fullWidth
              loading={loading && choice === "stop"}
              disabled={loading && choice !== "stop"}
              onClick={() => {
                setChoice("stop");
                onStopAndSave(value());
              }}
            >
              Stop &amp; save
            </Button>
            <Button
              variant="ghost"
              size="md"
              fullWidth
              disabled={loading}
              onClick={onResume}
            >
              Keep recording
            </Button>
          </div>
        </Card>
      </div>
    </Overlay>
  );
}
