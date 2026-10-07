import React, { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import clsx from "clsx";

import type { ActionManager } from "../actions/manager";
import { actionCopyElementLink } from "../actions/actionElementLink";
import type {
  NonDeletedElementsMap,
  NonDeletedSceneElementsMap,
} from "../element/types";
import type { AppClassProperties, UIAppState } from "../types";
import { t } from "../i18n";
import {
  canChangeRoundness,
  canHaveArrowheads,
  getSelectedElements,
  getTargetElements,
  hasBackground,
  hasStrokeStyle,
  hasStrokeWidth,
} from "../scene";
import { toolIsArrow } from "../scene/comparisons";
import { isTextElement } from "../element/typeChecks";
import { canCreateLinkFromElements } from "../element/elementLink";
import { getShortcutKey } from "../utils";
import { useExcalidrawContainer } from "./App";
import { PropertiesPopover } from "./PropertiesPopover";
import {
  DotsIcon,
  TextIcon,
  ArrowheadArrowIcon,
  TrashIcon,
  DuplicateIcon,
  LinkIcon,
  GroupIcon,
  UngroupIcon,
} from "./icons";
import { canChangeStrokeColor, canChangeBackgroundColor } from "./Actions";

/**
 * Praksis compact context bar (fork opt-in via
 * `UIOptions.chrome.compactContextBar`).
 *
 * A small, contextual row over the bottom toolbar — deliberately calm and
 * self-explanatory (Miro-like), instead of the flat always-open palette:
 *
 *   [stroke ring] [fill square] | [⚙ Stil ▾] | [type ▾] | [⋯ Mer ▾]
 *
 * Design contract (owner-approved polish pass):
 * - Color swatches reuse the existing color actions in compact mode. The stroke
 *   swatch reads as a *ring* (hollow), the fill swatch as a filled square, so
 *   the bar is legible at a glance (styling lives in the flag-scoped SCSS).
 * - "Stil" gathers width, style, edges, fill style and opacity inside one
 *   popover that opens upward. Every option group renders as a *horizontal*
 *   segmented button group (no vertical radio rows, no radio circles); the
 *   selected value shows as a highlighted button. Roughness / edges live behind
 *   a collapsed "Flere stilvalg" expander.
 * - Type-specific controls (arrowheads / arrow type for arrows & lines, font +
 *   alignment for text) only appear for the matching element type.
 * - "Mer" is a real menu: duplicate (with shortcut hint), copy link, a single
 *   horizontal "Rekkefølge" (layer order) row, alignment only on multi-select,
 *   group / ungroup only when relevant, and a danger "Slett" at the bottom.
 *
 * Popover discipline: at most one of our own popovers (Stil / type / Mer) is
 * open at a time (single `openSection` state), and it always cross-closes with
 * the color pickers. Esc / outside-click always close (Radix).
 *
 * All behaviour is delegated to the existing `renderAction(...)` PanelComponents
 * (or the registered action via `actionManager.executeAction`) — no action
 * logic is duplicated here.
 */

type Section = "style" | "type" | "more";

const CompactPopoverButton = ({
  icon,
  label,
  title,
  section,
  openSection,
  setOpenSection,
  container,
  withText = false,
  className,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  /** tooltip; falls back to label */
  title?: string;
  section: Section;
  openSection: Section | null;
  setOpenSection: (section: Section | null) => void;
  container: HTMLDivElement | null;
  /** render the label as visible text next to the icon (e.g. "Stil") */
  withText?: boolean;
  className?: string;
  children: React.ReactNode;
}) => {
  const open = openSection === section;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => setOpenSection(next ? section : null)}
    >
      <Popover.Trigger
        type="button"
        className={clsx("compact-context__trigger", className, {
          "compact-context__trigger--active": open,
          "compact-context__trigger--labeled": withText,
        })}
        title={title ?? label}
        aria-label={label}
      >
        <span className="compact-context__trigger-icon">{icon}</span>
        {withText && (
          <span className="compact-context__trigger-label">{label}</span>
        )}
      </Popover.Trigger>
      <PropertiesPopover
        className={clsx("compact-context__popover", {
          "compact-context__popover--menu": section === "more",
        })}
        container={container}
        side="top"
        align="center"
        onClose={() => setOpenSection(null)}
      >
        <div
          className={clsx("compact-context__popover-body", {
            "compact-context__menu": section === "more",
          })}
        >
          {children}
        </div>
      </PropertiesPopover>
    </Popover.Root>
  );
};

/** Sliders / adjustments glyph for the "Stil" trigger. */
const StyleGlyph = (
  <svg
    aria-hidden="true"
    focusable="false"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <line x1="4" y1="7" x2="20" y2="7" />
    <line x1="4" y1="17" x2="20" y2="17" />
    <circle cx="9" cy="7" r="2.2" fill="var(--island-bg-color, #fff)" />
    <circle cx="15" cy="17" r="2.2" fill="var(--island-bg-color, #fff)" />
  </svg>
);

/**
 * A single icon+text menu row that triggers an existing registered action.
 * Reuses the action's `perform` via the action manager (no duplicated logic).
 */
const CompactMenuItem = ({
  icon,
  label,
  shortcut,
  danger,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  danger?: boolean;
  onSelect: () => void;
}) => (
  <button
    type="button"
    className={clsx("compact-context__menu-item", {
      "compact-context__menu-item--danger": danger,
    })}
    onClick={onSelect}
  >
    <span className="compact-context__menu-icon">{icon}</span>
    <span className="compact-context__menu-label">{label}</span>
    {shortcut && (
      <span className="compact-context__menu-shortcut">{shortcut}</span>
    )}
  </button>
);

export const CompactSelectedShapeActions = ({
  appState,
  elementsMap,
  renderAction,
  actionManager,
  app,
}: {
  appState: UIAppState;
  elementsMap: NonDeletedElementsMap | NonDeletedSceneElementsMap;
  renderAction: ActionManager["renderAction"];
  actionManager: ActionManager;
  app: AppClassProperties;
}) => {
  const { container } = useExcalidrawContainer();
  const [openSection, setOpenSection] = useState<Section | null>(null);
  // "Flere stilvalg" expander inside the Stil popover (roughness / edges).
  const [showMoreStyle, setShowMoreStyle] = useState(false);

  // Single-popover contract: at most ONE popover (a color picker OR a
  // Style/Type/More section) may be open at any time.
  //
  // Color pickers self-manage their open state via `appState.openPopup`;
  // the sections are tracked locally in `openSection`. Coordinate the two so
  // opening one always closes the other:
  //  - when a color popup opens, drop any open section (effect below);
  //  - when a section opens, close any open color popup (handleOpenSection).
  const colorPopupOpen =
    appState.openPopup === "elementStroke" ||
    appState.openPopup === "elementBackground";

  useEffect(() => {
    if (colorPopupOpen) {
      setOpenSection(null);
    }
  }, [colorPopupOpen]);

  // collapse the "Flere stilvalg" expander whenever the Stil popover closes
  useEffect(() => {
    if (openSection !== "style") {
      setShowMoreStyle(false);
    }
  }, [openSection]);

  // Close every compact popover (our own sections AND the color pickers).
  const closeAllPopovers = React.useCallback(() => {
    setOpenSection(null);
    if (
      appState.openPopup === "elementStroke" ||
      appState.openPopup === "elementBackground"
    ) {
      app.setOpenPopup(null);
    }
  }, [app, appState.openPopup]);

  // Funn 1 — canvas-click must close open popovers.
  //
  // Root cause: the interactive canvas calls `setPointerCapture` on
  // pointerdown (App.handleCanvasPointerDown), which swallows the event before
  // it bubbles to `document`, so Radix' `onPointerDownOutside` (which listens
  // on document) never fires while a popover is open. We therefore listen
  // directly on the interactive canvas element in the CAPTURE phase — this
  // runs before React's own handler and before pointer capture matters — and
  // close all our popovers. Scoped to the fork's own component; no change to
  // App's pointer pipeline.
  useEffect(() => {
    if (!container) {
      return;
    }
    const canvas = container.querySelector<HTMLElement>(
      ".excalidraw__canvas.interactive",
    );
    if (!canvas) {
      return;
    }
    const onCanvasPointerDown = () => {
      closeAllPopovers();
    };
    canvas.addEventListener("pointerdown", onCanvasPointerDown, {
      capture: true,
    });
    return () => {
      canvas.removeEventListener("pointerdown", onCanvasPointerDown, {
        capture: true,
      } as EventListenerOptions);
    };
  }, [container, closeAllPopovers]);

  // Funn 1 (belt & suspenders) — a changed OR emptied selection means the user
  // moved on; close every compact popover so nothing lingers on the canvas.
  const selectionKey = Object.keys(appState.selectedElementIds)
    .sort()
    .join(",");
  const prevSelectionKey = React.useRef(selectionKey);
  useEffect(() => {
    if (prevSelectionKey.current !== selectionKey) {
      prevSelectionKey.current = selectionKey;
      closeAllPopovers();
    }
  }, [selectionKey, closeAllPopovers]);

  const handleOpenSection = (section: Section | null) => {
    if (section && colorPopupOpen) {
      app.setOpenPopup(null);
    }
    setOpenSection(section);
  };

  const targetElements = getTargetElements(elementsMap, appState);
  const selectedElements = getSelectedElements(elementsMap, appState);
  const isMultiSelect = selectedElements.length > 1;

  const showStrokeColor = canChangeStrokeColor(appState, targetElements);
  const showBackgroundColor = canChangeBackgroundColor(
    appState,
    targetElements,
  );

  const canWidth =
    hasStrokeWidth(appState.activeTool.type) ||
    targetElements.some((el) => hasStrokeWidth(el.type));
  const canStrokeStyle =
    hasStrokeStyle(appState.activeTool.type) ||
    targetElements.some((el) => hasStrokeStyle(el.type));
  const canRoundness =
    canChangeRoundness(appState.activeTool.type) ||
    targetElements.some((el) => canChangeRoundness(el.type));
  const canFillStyle =
    (hasBackground(appState.activeTool.type) ||
      targetElements.some((el) => hasBackground(el.type))) &&
    showBackgroundColor;
  const isFreedraw =
    appState.activeTool.type === "freedraw" ||
    targetElements.some((el) => el.type === "freedraw");

  const showStyleSection =
    canWidth || canStrokeStyle || canRoundness || canFillStyle || isFreedraw;
  // "Flere stilvalg" gathers the secondary controls (Ujevnhet + kantrunding),
  // collapsed by default (owner decision, funn 2). It only exists when at least
  // one of those controls is actually available.
  const hasMoreStyle = canStrokeStyle || canRoundness;

  const isArrowish =
    toolIsArrow(appState.activeTool.type) ||
    targetElements.some((el) => toolIsArrow(el.type)) ||
    canHaveArrowheads(appState.activeTool.type) ||
    targetElements.some((el) => canHaveArrowheads(el.type));

  const isTextish =
    appState.activeTool.type === "text" || targetElements.some(isTextElement);

  const showGroup = isMultiSelect;
  const showUngroup = Object.values(appState.selectedGroupIds).some(Boolean);
  const showCopyLink = canCreateLinkFromElements(selectedElements);

  return (
    <div className="compact-context" data-testid="compact-context-bar">
      {/* Single color indicators — self-managed popovers via appState.openPopup */}
      {showStrokeColor && (
        <div className="compact-context__color compact-context__color--stroke">
          {renderAction("changeStrokeColor", { compact: true })}
        </div>
      )}
      {showBackgroundColor && (
        <div className="compact-context__color compact-context__color--fill">
          {renderAction("changeBackgroundColor", { compact: true })}
        </div>
      )}

      {(showStrokeColor || showBackgroundColor) && showStyleSection && (
        <div className="compact-context__divider" />
      )}

      {/* Grouped style controls — horizontal segmented groups inside */}
      {showStyleSection && (
        <CompactPopoverButton
          icon={StyleGlyph}
          label={t("labels.style")}
          section="style"
          openSection={openSection}
          setOpenSection={handleOpenSection}
          container={container}
          withText
        >
          {canWidth && renderAction("changeStrokeWidth")}
          {isFreedraw && renderAction("changeStrokeShape")}
          {canStrokeStyle && renderAction("changeStrokeStyle")}
          {canFillStyle && renderAction("changeFillStyle")}
          {renderAction("changeOpacity")}

          {hasMoreStyle && (
            <div className="compact-context__expander">
              <button
                type="button"
                className="compact-context__expander-toggle"
                aria-expanded={showMoreStyle}
                onClick={() => setShowMoreStyle((v) => !v)}
              >
                {t("labels.moreStyleOptions")}
                <span
                  className={clsx("compact-context__expander-caret", {
                    "compact-context__expander-caret--open": showMoreStyle,
                  })}
                  aria-hidden="true"
                >
                  ▾
                </span>
              </button>
              {showMoreStyle && (
                <div className="compact-context__expander-body">
                  {/* Ujevnhet (sloppiness) + kantrunding live here, collapsed
                      by default (funn 2). */}
                  {canStrokeStyle && renderAction("changeSloppiness")}
                  {canRoundness && renderAction("changeRoundness")}
                </div>
              )}
            </div>
          )}
        </CompactPopoverButton>
      )}

      {(showStyleSection && (isArrowish || isTextish)) ||
      (!showStyleSection && (showStrokeColor || showBackgroundColor)) ? (
        <div className="compact-context__divider" />
      ) : null}

      {/* Type-specific: arrows (arrow type + arrowheads) */}
      {isArrowish && (
        <CompactPopoverButton
          icon={<ArrowheadArrowIcon />}
          label={t("labels.arrowtypes")}
          section="type"
          openSection={openSection}
          setOpenSection={handleOpenSection}
          container={container}
        >
          {renderAction("changeArrowType")}
          {renderAction("changeArrowhead")}
        </CompactPopoverButton>
      )}

      {/* Type-specific: text (font, size, alignment) */}
      {isTextish && (
        <CompactPopoverButton
          icon={TextIcon}
          label={t("labels.fontFamily")}
          section="type"
          openSection={openSection}
          setOpenSection={handleOpenSection}
          container={container}
        >
          {renderAction("changeFontFamily")}
          {renderAction("changeFontSize")}
          {renderAction("changeTextAlign")}
          {renderAction("changeVerticalAlign")}
        </CompactPopoverButton>
      )}

      <div className="compact-context__divider" />

      {/* More: a real menu (icon + text rows) */}
      <CompactPopoverButton
        icon={DotsIcon}
        label={t("labels.more_options")}
        section="more"
        openSection={openSection}
        setOpenSection={handleOpenSection}
        container={container}
      >
        <CompactMenuItem
          icon={DuplicateIcon}
          label={t("labels.duplicateSelection")}
          shortcut={getShortcutKey("CtrlOrCmd+D")}
          onSelect={() => {
            setOpenSection(null);
            actionManager.executeAction(
              actionManager.actions.duplicateSelection,
              "ui",
            );
          }}
        />
        {showCopyLink && (
          <CompactMenuItem
            icon={LinkIcon}
            label={t("labels.copyElementLink")}
            onSelect={() => {
              setOpenSection(null);
              actionManager.executeAction(actionCopyElementLink, "ui");
            }}
          />
        )}

        <div className="compact-context__menu-divider" />

        <div className="compact-context__menu-section">
          <div className="compact-context__menu-section-label">
            {t("labels.layers")}
          </div>
          <div className="buttonList compact-context__order-row">
            {renderAction("sendToBack")}
            {renderAction("sendBackward")}
            {renderAction("bringForward")}
            {renderAction("bringToFront")}
          </div>
        </div>

        {/* "Juster" (alignment) only makes sense for 2+ elements */}
        {isMultiSelect && (
          <div className="compact-context__menu-section">
            <div className="compact-context__menu-section-label">
              {t("labels.align")}
            </div>
            <div className="buttonList compact-context__align-row">
              {renderAction("alignLeft")}
              {renderAction("alignHorizontallyCentered")}
              {renderAction("alignRight")}
              {renderAction("alignTop")}
              {renderAction("alignVerticallyCentered")}
              {renderAction("alignBottom")}
            </div>
          </div>
        )}

        {(showGroup || showUngroup) && (
          <>
            <div className="compact-context__menu-divider" />
            {showGroup && (
              <CompactMenuItem
                icon={<GroupIcon theme={appState.theme} />}
                label={t("labels.group")}
                shortcut={getShortcutKey("CtrlOrCmd+G")}
                onSelect={() => {
                  setOpenSection(null);
                  actionManager.executeAction(
                    actionManager.actions.group,
                    "ui",
                  );
                }}
              />
            )}
            {showUngroup && (
              <CompactMenuItem
                icon={<UngroupIcon theme={appState.theme} />}
                label={t("labels.ungroup")}
                shortcut={getShortcutKey("CtrlOrCmd+Shift+G")}
                onSelect={() => {
                  setOpenSection(null);
                  actionManager.executeAction(
                    actionManager.actions.ungroup,
                    "ui",
                  );
                }}
              />
            )}
          </>
        )}

        <div className="compact-context__menu-divider" />

        <CompactMenuItem
          icon={TrashIcon}
          label={t("labels.delete")}
          shortcut={getShortcutKey("Delete")}
          danger
          onSelect={() => {
            setOpenSection(null);
            actionManager.executeAction(
              actionManager.actions.deleteSelectedElements,
              "ui",
            );
          }}
        />
      </CompactPopoverButton>
    </div>
  );
};
