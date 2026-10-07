import {
  CUSTOM_FONT_FAMILY_NAMES,
  FONT_FAMILY,
  FONT_FAMILY_FALLBACKS,
  CJK_HAND_DRAWN_FALLBACK_FONT,
  WINDOWS_EMOJI_FALLBACK_FONT,
  getFontFamilyFallbacks,
} from "../constants";
import { isTextElement } from "../element";
import { getContainerElement } from "../element/textElement";
import { containsCJK } from "../element/textWrapping";
import { ShapeCache } from "../scene/ShapeCache";
import { getFontString, PromisePool, promiseTry } from "../utils";
import { ExcalidrawFontFace } from "./ExcalidrawFontFace";

import { CascadiaFontFaces } from "./Cascadia";
import { ComicShannsFontFaces } from "./ComicShanns";
import { EmojiFontFaces } from "./Emoji";
import { ExcalifontFontFaces } from "./Excalifont";
import { HelveticaFontFaces } from "./Helvetica";
import { LiberationFontFaces } from "./Liberation";
import { LilitaFontFaces } from "./Lilita";
import { NunitoFontFaces } from "./Nunito";
import { VirgilFontFaces } from "./Virgil";
import { XiaolaiFontFaces } from "./Xiaolai";

import { FONT_METADATA, type FontMetadata } from "./FontMetadata";
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
  FontFamilyValues,
} from "../element/types";
import type Scene from "../scene/Scene";
import type { ValueOf } from "../utility-types";
import { charWidth } from "../element/textMeasurements";

export class Fonts {
  // it's ok to track fonts across multiple instances only once, so let's use
  // a static member to reduce memory footprint
  public static readonly loadedFontsCache = new Set<string>();

  private static _registered:
    | Map<
        number,
        {
          metadata: FontMetadata;
          fontFaces: ExcalidrawFontFace[];
        }
      >
    | undefined;

  private static _initialized: boolean = false;

  public static get registered() {
    // lazy load the font registration
    if (!Fonts._registered) {
      Fonts._registered = Fonts.init();
    } else if (!Fonts._initialized) {
      // case when host app register fonts before they are lazy loaded
      // don't override whatever has been previously registered
      Fonts._registered = new Map([
        ...Fonts.init().entries(),
        ...Fonts._registered.entries(),
      ]);
    }

    return Fonts._registered;
  }

  public get registered() {
    return Fonts.registered;
  }

  private readonly scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  /**
   * Get all the font families for the given scene.
   */
  public getSceneFamilies = () => {
    return Fonts.getUniqueFamilies(this.scene.getNonDeletedElements());
  };

  /**
   * if we load a (new) font, it's likely that text elements using it have
   * already been rendered using a fallback font. Thus, we want invalidate
   * their shapes and rerender. See #637.
   *
   * Invalidates text elements and rerenders scene, provided that at least one
   * of the supplied fontFaces has not already been processed.
   */
  public onLoaded = (fontFaces: readonly FontFace[]): void => {
    // bail if all fonts with have been processed. We're checking just a
    // subset of the font properties (though it should be enough), so it
    // can technically bail on a false positive.
    let shouldBail = true;

    for (const fontFace of fontFaces) {
      const sig = `${fontFace.family}-${fontFace.style}-${fontFace.weight}-${fontFace.unicodeRange}`;

      // make sure to update our cache with all the loaded font faces
      if (!Fonts.loadedFontsCache.has(sig)) {
        Fonts.loadedFontsCache.add(sig);
        shouldBail = false;
      }
    }

    if (shouldBail) {
      return;
    }

    let didUpdate = false;

    const elementsMap = this.scene.getNonDeletedElementsMap();

    for (const element of this.scene.getNonDeletedElements()) {
      if (isTextElement(element)) {
        didUpdate = true;
        ShapeCache.delete(element);

        // clear the width cache, so that we don't perform subsequent wrapping based on the stale fallback font metrics
        charWidth.clearCache(getFontString(element));

        const container = getContainerElement(element, elementsMap);
        if (container) {
          ShapeCache.delete(container);
        }
      }
    }

    if (didUpdate) {
      this.scene.triggerUpdate();
    }
  };

  /**
   * Load font faces for a given scene and trigger scene update.
   */
  public loadSceneFonts = async (): Promise<FontFace[]> => {
    const sceneFamilies = this.getSceneFamilies();
    const charsPerFamily = Fonts.getCharsPerFamily(
      this.scene.getNonDeletedElements(),
    );

    return Fonts.loadFontFaces(sceneFamilies, charsPerFamily);
  };

  /**
   * Load font faces for passed elements - use when the scene is unavailable (i.e. export).
   */
  public static loadElementsFonts = async (
    elements: readonly ExcalidrawElement[],
  ): Promise<FontFace[]> => {
    const fontFamilies = Fonts.getUniqueFamilies(elements);
    const charsPerFamily = Fonts.getCharsPerFamily(elements);

    return Fonts.loadFontFaces(fontFamilies, charsPerFamily);
  };

  /**
   * Generate CSS @font-face declarations for the given elements.
   */
  public static async generateFontFaceDeclarations(
    elements: readonly ExcalidrawElement[],
  ) {
    const families = Fonts.getUniqueFamilies(elements);
    const charsPerFamily = Fonts.getCharsPerFamily(elements);

    // for simplicity, assuming we have just one family with the CJK handdrawn fallback
    const familyWithCJK = families.find((x) =>
      getFontFamilyFallbacks(x).includes(CJK_HAND_DRAWN_FALLBACK_FONT),
    );

    if (familyWithCJK) {
      const characters = Fonts.getCharacters(charsPerFamily, familyWithCJK);

      if (containsCJK(characters)) {
        const family = FONT_FAMILY_FALLBACKS[CJK_HAND_DRAWN_FALLBACK_FONT];

        // adding the same characters to the CJK handrawn family
        charsPerFamily[family] = new Set(characters);

        // the order between the families and fallbacks is important, as fallbacks need to be defined first and in the reversed order
        // so that they get overriden with the later defined font faces, i.e. in case they share some codepoints
        families.unshift(FONT_FAMILY_FALLBACKS[CJK_HAND_DRAWN_FALLBACK_FONT]);
      }
    }

    // don't trigger hundreds of concurrent requests (each performing fetch, creating a worker, etc.),
    // instead go three requests at a time, in a controlled manner, without completely blocking the main thread
    // and avoiding potential issues such as rate limits
    const iterator = Fonts.fontFacesStylesGenerator(families, charsPerFamily);
    const concurrency = 3;
    const fontFaces = await new PromisePool(iterator, concurrency).all();

    // dedup just in case (i.e. could be the same font faces with 0 glyphs)
    return Array.from(new Set(fontFaces));
  }

  private static async loadFontFaces(
    fontFamilies: Array<ExcalidrawTextElement["fontFamily"]>,
    charsPerFamily: Record<number, Set<string>>,
  ) {
    // add all registered font faces into the `document.fonts` (if not added already)
    for (const { fontFaces, metadata } of Fonts.registered.values()) {
      // skip registering font faces for local fonts (i.e. Helvetica)
      if (metadata.local) {
        continue;
      }

      for (const { fontFace } of fontFaces) {
        if (!window.document.fonts.has(fontFace)) {
          window.document.fonts.add(fontFace);
        }
      }
    }

    // loading 10 font faces at a time, in a controlled manner
    const iterator = Fonts.fontFacesLoader(fontFamilies, charsPerFamily);
    const concurrency = 10;
    const fontFaces = await new PromisePool(iterator, concurrency).all();
    return fontFaces.flat().filter(Boolean);
  }

  private static *fontFacesLoader(
    fontFamilies: Array<ExcalidrawTextElement["fontFamily"]>,
    charsPerFamily: Record<number, Set<string>>,
  ): Generator<Promise<void | readonly [number, FontFace[]]>> {
    for (const [index, fontFamily] of fontFamilies.entries()) {
      const font = getFontString({
        fontFamily,
        fontSize: 16,
      });

      // WARN: without "text" param it does not have to mean that all font faces are loaded as it could be just one irrelevant font face!
      // instead, we are always checking chars used in the family, so that no required font faces remain unloaded
      const text = Fonts.getCharacters(charsPerFamily, fontFamily);

      if (!window.document.fonts.check(font, text)) {
        yield promiseTry(async () => {
          try {
            // WARN: browser prioritizes loading only font faces with unicode ranges for characters which are present in the document (html & canvas), other font faces could stay unloaded
            // we might want to retry here, i.e.  in case CDN is down, but so far I didn't experience any issues - maybe it handles retry-like logic under the hood
            const fontFaces = await window.document.fonts.load(font, text);

            return [index, fontFaces];
          } catch (e) {
            // don't let it all fail if just one font fails to load
            console.error(
              `Failed to load font "${font}" from urls "${Fonts.registered
                .get(fontFamily)
                ?.fontFaces.map((x) => x.urls)}"`,
              e,
            );
          }
        });
      }
    }
  }

  private static *fontFacesStylesGenerator(
    families: Array<number>,
    charsPerFamily: Record<number, Set<string>>,
  ): Generator<Promise<void | readonly [number, string]>> {
    for (const [familyIndex, family] of families.entries()) {
      const { fontFaces, metadata } = Fonts.registered.get(family) ?? {};

      if (!Array.isArray(fontFaces)) {
        console.error(
          `Couldn't find registered fonts for font-family "${family}"`,
          Fonts.registered,
        );
        continue;
      }

      if (metadata?.local) {
        // don't inline local fonts
        continue;
      }

      for (const [fontFaceIndex, fontFace] of fontFaces.entries()) {
        yield promiseTry(async () => {
          try {
            const characters = Fonts.getCharacters(charsPerFamily, family);
            const fontFaceCSS = await fontFace.toCSS(characters);

            if (!fontFaceCSS) {
              return;
            }

            // giving a buffer of 10K font faces per family
            const fontFaceOrder = familyIndex * 10_000 + fontFaceIndex;
            const fontFaceTuple = [fontFaceOrder, fontFaceCSS] as const;

            return fontFaceTuple;
          } catch (error) {
            console.error(
              `Couldn't transform font-face to css for family "${fontFace.fontFace.family}"`,
              error,
            );
          }
        });
      }
    }
  }

  /**
   * Register a new font.
   *
   * @param family font family
   * @param metadata font metadata
   * @param fontFacesDecriptors font faces descriptors
   */
  private static register(
    this:
      | Fonts
      | {
          registered: Map<
            number,
            { metadata: FontMetadata; fontFaces: ExcalidrawFontFace[] }
          >;
        },
    family: string,
    metadata: FontMetadata,
    ...fontFacesDecriptors: ExcalidrawFontFaceDescriptor[]
  ) {
    // TODO: likely we will need to abandon number value in order to support custom fonts
    const fontFamily =
      FONT_FAMILY[family as keyof typeof FONT_FAMILY] ??
      FONT_FAMILY_FALLBACKS[family as keyof typeof FONT_FAMILY_FALLBACKS];

    const registeredFamily = this.registered.get(fontFamily);

    if (!registeredFamily) {
      this.registered.set(fontFamily, {
        metadata,
        fontFaces: fontFacesDecriptors.map(
          ({ uri, descriptors }) =>
            new ExcalidrawFontFace(family, uri, descriptors),
        ),
      });
    }

    return this.registered;
  }

  // ---------------------------------------------------------------------------
  // Praksis fork (funn 3): host-registered custom font families.
  //
  // Excalidraw identifies a font family by a numeric id and resolves that id
  // back to a CSS family *name* by scanning the built-in `FONT_FAMILY` enum
  // (see `getFontFamilyString` in utils.ts). Host-registered families use ids
  // that are NOT in that enum, so we keep a runtime id→name map here that the
  // resolver consults before falling back. This is the single extension point
  // the code's own TODO ("abandon number value to support custom fonts")
  // pointed at — done narrowly, without touching the built-in path.
  // ---------------------------------------------------------------------------
  /**
   * label shown in the picker for each host-registered family (id → label),
   * so the compact "Vekt" control can show host-defined weight names.
   */
  private static _customFamilyLabels: Map<number, string> = new Map();

  /** id → CSS family name for host-registered families (empty by default). */
  public static get customFamilyNames(): ReadonlyMap<number, string> {
    return CUSTOM_FONT_FAMILY_NAMES;
  }

  /** id → picker label for host-registered families (empty by default). */
  public static get customFamilyLabels(): ReadonlyMap<number, string> {
    return Fonts._customFamilyLabels;
  }

  /**
   * ids of host-registered families, in registration order. Empty unless a
   * host called {@link registerCustomFonts}. Used by the FontPicker to REPLACE
   * the built-in quick-select fonts with the host's own families/weights.
   */
  public static get customFamilyIds(): readonly number[] {
    return Array.from(CUSTOM_FONT_FAMILY_NAMES.keys());
  }

  /**
   * Host-facing API: register custom font families that REPLACE the default
   * font choices in the picker. Each definition is one registered family (in
   * the Praksis use-case, each is a distinct *weight* of the same typeface,
   * since Excalidraw elements carry a fontFamily id but no fontWeight).
   *
   * Safe to call before or after lazy init — it merges into the live registry
   * and never overrides a family that is already registered under the same id.
   * Host must own its id space (use large ids, e.g. >= 1_000_000, so they
   * never collide with built-ins or the reserved fallbacks).
   */
  public static registerCustomFonts(
    definitions: ReadonlyArray<CustomFontFamilyDefinition>,
  ): void {
    if (!definitions.length) {
      return;
    }

    // ensure the built-in registry exists first (without clobbering it)
    const registered = Fonts.registered;

    for (const def of definitions) {
      if (registered.has(def.id)) {
        // never override an already-registered family (idempotent re-register)
        continue;
      }

      const metadata: FontMetadata = {
        metrics: def.metrics ?? FONT_METADATA[FONT_FAMILY.Nunito].metrics,
        icon: def.icon,
      };

      registered.set(def.id, {
        metadata,
        fontFaces: def.fontFaces.map(
          ({ uri, descriptors }) =>
            new ExcalidrawFontFace(def.family, uri, descriptors),
        ),
      });

      CUSTOM_FONT_FAMILY_NAMES.set(def.id, def.family);
      if (def.label) {
        Fonts._customFamilyLabels.set(def.id, def.label);
      }
    }
  }

  /**
   * WARN: should be called just once on init, even across multiple instances.
   */
  private static init() {
    const fonts = {
      registered: new Map<
        ValueOf<typeof FONT_FAMILY | typeof FONT_FAMILY_FALLBACKS>,
        { metadata: FontMetadata; fontFaces: ExcalidrawFontFace[] }
      >(),
    };

    const init = (
      family: keyof typeof FONT_FAMILY | keyof typeof FONT_FAMILY_FALLBACKS,
      ...fontFacesDescriptors: ExcalidrawFontFaceDescriptor[]
    ) => {
      const fontFamily =
        FONT_FAMILY[family as keyof typeof FONT_FAMILY] ??
        FONT_FAMILY_FALLBACKS[family as keyof typeof FONT_FAMILY_FALLBACKS];

      // default to Excalifont metrics
      const metadata =
        FONT_METADATA[fontFamily] ?? FONT_METADATA[FONT_FAMILY.Excalifont];

      Fonts.register.call(fonts, family, metadata, ...fontFacesDescriptors);
    };

    init("Cascadia", ...CascadiaFontFaces);
    init("Comic Shanns", ...ComicShannsFontFaces);
    init("Excalifont", ...ExcalifontFontFaces);
    // keeping for backwards compatibility reasons, uses system font (Helvetica on MacOS, Arial on Win)
    init("Helvetica", ...HelveticaFontFaces);
    // used for server-side pdf & png export instead of helvetica (technically does not need metrics, but kept in for consistency)
    init("Liberation Sans", ...LiberationFontFaces);
    init("Lilita One", ...LilitaFontFaces);
    init("Nunito", ...NunitoFontFaces);
    init("Virgil", ...VirgilFontFaces);

    // fallback font faces
    init(CJK_HAND_DRAWN_FALLBACK_FONT, ...XiaolaiFontFaces);
    init(WINDOWS_EMOJI_FALLBACK_FONT, ...EmojiFontFaces);

    Fonts._initialized = true;

    return fonts.registered;
  }

  /**
   * Get all the unique font families for the given elements.
   */
  private static getUniqueFamilies(
    elements: ReadonlyArray<ExcalidrawElement>,
  ): Array<ExcalidrawTextElement["fontFamily"]> {
    return Array.from(
      elements.reduce((families, element) => {
        if (isTextElement(element)) {
          families.add(element.fontFamily);
        }
        return families;
      }, new Set<number>()),
    );
  }

  /**
   * Get all the unique characters per font family for the given scene.
   */
  private static getCharsPerFamily(
    elements: ReadonlyArray<ExcalidrawElement>,
  ): Record<number, Set<string>> {
    const charsPerFamily: Record<number, Set<string>> = {};

    for (const element of elements) {
      if (!isTextElement(element)) {
        continue;
      }

      // gather unique codepoints only when inlining fonts
      for (const char of element.originalText) {
        if (!charsPerFamily[element.fontFamily]) {
          charsPerFamily[element.fontFamily] = new Set();
        }

        charsPerFamily[element.fontFamily].add(char);
      }
    }

    return charsPerFamily;
  }

  /**
   * Get characters for a given family.
   */
  private static getCharacters(
    charsPerFamily: Record<number, Set<string>>,
    family: number,
  ) {
    return charsPerFamily[family]
      ? Array.from(charsPerFamily[family]).join("")
      : "";
  }

  /**
   * Get all registered font families.
   */
  private static getAllFamilies() {
    return Array.from(Fonts.registered.keys());
  }
}

/**
 * Calculates vertical offset for a text with alphabetic baseline.
 */
export const getVerticalOffset = (
  fontFamily: ExcalidrawTextElement["fontFamily"],
  fontSize: ExcalidrawTextElement["fontSize"],
  lineHeightPx: number,
) => {
  const { unitsPerEm, ascender, descender } =
    Fonts.registered.get(fontFamily)?.metadata.metrics ||
    FONT_METADATA[FONT_FAMILY.Virgil].metrics;

  const fontSizeEm = fontSize / unitsPerEm;
  const lineGap =
    (lineHeightPx - fontSizeEm * ascender + fontSizeEm * descender) / 2;

  const verticalOffset = fontSizeEm * ascender + lineGap;
  return verticalOffset;
};

/**
 * Gets line height forr a selected family.
 */
export const getLineHeight = (fontFamily: FontFamilyValues) => {
  const { lineHeight } =
    Fonts.registered.get(fontFamily)?.metadata.metrics ||
    FONT_METADATA[FONT_FAMILY.Excalifont].metrics;

  return lineHeight as ExcalidrawTextElement["lineHeight"];
};

export interface ExcalidrawFontFaceDescriptor {
  uri: string;
  descriptors?: FontFaceDescriptors;
}

/**
 * Praksis fork (funn 3): a host-defined font family that replaces the built-in
 * font choices in the picker. In the Praksis use-case each definition is one
 * *weight* of the same typeface (Excalidraw elements carry a fontFamily id but
 * no fontWeight, so each weight must be its own registered family).
 */
export interface CustomFontFamilyDefinition {
  /**
   * Numeric family id stored on the element. Host owns this id space — use
   * large ids (e.g. >= 1_000_000) so they never collide with built-in fonts
   * or the reserved fallback ids.
   */
  id: number;
  /** CSS `font-family` name. Must match the @font-face the host provides. */
  family: string;
  /** one source per definition (usually a single weight of the typeface). */
  fontFaces: ExcalidrawFontFaceDescriptor[];
  /** label shown in the picker (e.g. "Normal" / "Medium" / "Halvfet"). */
  label?: string;
  /** icon shown in the picker's quick-select row. */
  icon?: FontMetadata["icon"];
  /** font metrics; defaults to Nunito's if omitted. */
  metrics?: FontMetadata["metrics"];
}
