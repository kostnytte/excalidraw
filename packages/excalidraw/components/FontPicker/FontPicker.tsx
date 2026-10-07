import React, { useCallback, useMemo } from "react";
import * as Popover from "@radix-ui/react-popover";

import { FontPickerList } from "./FontPickerList";
import { FontPickerTrigger } from "./FontPickerTrigger";
import { ButtonIconSelect } from "../ButtonIconSelect";
import {
  FontFamilyCodeIcon,
  FontFamilyNormalIcon,
  FreedrawIcon,
} from "../icons";
import { ButtonSeparator } from "../ButtonSeparator";
import { Fonts } from "../../fonts/Fonts";
import type { FontFamilyValues } from "../../element/types";
import { FONT_FAMILY } from "../../constants";
import { t } from "../../i18n";

import "./FontPicker.scss";

export const DEFAULT_FONTS = [
  {
    value: FONT_FAMILY.Excalifont,
    icon: FreedrawIcon,
    text: t("labels.handDrawn"),
    testId: "font-family-hand-drawn",
  },
  {
    value: FONT_FAMILY.Nunito,
    icon: FontFamilyNormalIcon,
    text: t("labels.normal"),
    testId: "font-family-normal",
  },
  {
    value: FONT_FAMILY["Comic Shanns"],
    icon: FontFamilyCodeIcon,
    text: t("labels.code"),
    testId: "font-family-code",
  },
];

/**
 * Praksis fork (funn 3): the quick-select fonts shown in the picker. When a
 * host has registered custom families (weights) via `Fonts.registerCustomFonts`
 * they REPLACE the built-in three, so the picker shows the host's own
 * weight labels (Normal / Medium / Halvfet …) instead of Excalidraw's
 * typefaces. Falls back to `DEFAULT_FONTS` when no host fonts are registered,
 * leaving upstream behaviour untouched.
 */
export const getQuickSelectFonts = () => {
  const customIds = Fonts.customFamilyIds;
  if (!customIds.length) {
    return DEFAULT_FONTS;
  }
  const labels = Fonts.customFamilyLabels;
  const names = Fonts.customFamilyNames;
  return customIds.map((value, index) => ({
    value,
    icon: FontFamilyNormalIcon,
    text: labels.get(value) ?? names.get(value) ?? `Font ${index + 1}`,
    testId: `font-family-custom-${index}`,
  }));
};

export const isDefaultFont = (fontFamily: number | null) => {
  if (!fontFamily) {
    return false;
  }

  const customIds = Fonts.customFamilyIds;
  if (customIds.length) {
    return customIds.includes(fontFamily);
  }

  return DEFAULT_FONTS.some((x) => x.value === fontFamily);
};

interface FontPickerProps {
  isOpened: boolean;
  selectedFontFamily: FontFamilyValues | null;
  hoveredFontFamily: FontFamilyValues | null;
  onSelect: (fontFamily: FontFamilyValues) => void;
  onHover: (fontFamily: FontFamilyValues) => void;
  onLeave: () => void;
  onPopupChange: (open: boolean) => void;
}

export const FontPicker = React.memo(
  ({
    isOpened,
    selectedFontFamily,
    hoveredFontFamily,
    onSelect,
    onHover,
    onLeave,
    onPopupChange,
  }: FontPickerProps) => {
    const quickSelectFonts = useMemo(() => getQuickSelectFonts(), []);
    // Praksis fork (funn 3): when the host has registered its own font
    // families (weights), those ARE the full set of choices — drop the "more
    // fonts" searchable list (which would otherwise surface the built-in
    // Excalidraw typefaces) so the picker only offers the host's weights.
    const hasCustomFonts = Fonts.customFamilyIds.length > 0;
    const onSelectCallback = useCallback(
      (value: number | false) => {
        if (value) {
          onSelect(value);
        }
      },
      [onSelect],
    );

    return (
      <div role="dialog" aria-modal="true" className="FontPicker__container">
        <ButtonIconSelect<FontFamilyValues | false>
          type="button"
          options={quickSelectFonts}
          value={selectedFontFamily}
          onClick={onSelectCallback}
        />
        {!hasCustomFonts && (
          <>
            <ButtonSeparator />
            <Popover.Root open={isOpened} onOpenChange={onPopupChange}>
              <FontPickerTrigger selectedFontFamily={selectedFontFamily} />
              {isOpened && (
                <FontPickerList
                  selectedFontFamily={selectedFontFamily}
                  hoveredFontFamily={hoveredFontFamily}
                  onSelect={onSelectCallback}
                  onHover={onHover}
                  onLeave={onLeave}
                  onOpen={() => onPopupChange(true)}
                  onClose={() => onPopupChange(false)}
                />
              )}
            </Popover.Root>
          </>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.isOpened === next.isOpened &&
    prev.selectedFontFamily === next.selectedFontFamily &&
    prev.hoveredFontFamily === next.hoveredFontFamily,
);
