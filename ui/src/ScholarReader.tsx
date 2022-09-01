import classNames from "classnames";
import jsPDF from "jspdf";
import React from "react";
import * as api from "./api/api";
import {
  Entity,
  EntityCreateData,
  EntityUpdateData,
  FacetedHighlight,
  isCitation,
  isEquation,
  isSymbol,
  isTerm,
  Paper,
  Symbol,
} from "./api/types";
import Control from "./components/control/Control";
import EntityCreationCanvas from "./components/control/EntityCreationCanvas";
import EntityCreationToolbar, {
  AreaSelectionMethod,
  createCreateEntityDataWithBoxes,
} from "./components/control/EntityCreationToolbar";
import MainControlPanel from "./components/control/MainControlPanel";
import TextSelectionMenu from "./components/control/TextSelectionMenu";
import { Drawer, DrawerContentType } from "./components/drawer/Drawer";
import DrawerControlFab from "./components/drawer/DrawerControlFab";
import EntityAnnotationLayer from "./components/entity/EntityAnnotationLayer";
import EquationDiagram from "./components/entity/equation/EquationDiagram";
import FacetLabelLayer from "./components/faceted-highlights/FacetLabelLayer";
import HighlightLayer from "./components/faceted-highlights/HighlightLayer";
import Legend from "./components/faceted-highlights/Legend";
import MarkerLayer from "./components/faceted-highlights/MarkerLayer";
import UnderlineLayer from "./components/faceted-highlights/UnderlineLayer";
import EntityPageMask from "./components/mask/EntityPageMask";
import SearchPageMask from "./components/mask/SearchPageMask";
import AppOverlay from "./components/overlay/AppOverlay";
import PageOverlay from "./components/overlay/PageOverlay";
import ViewerOverlay from "./components/overlay/ViewerOverlay";
import PdfjsToolbarLeft from "./components/pdfjs/PdfjsToolbarLeft";
import PdfjsToolbarRight from "./components/pdfjs/PdfjsToolbarRight";
import DefinitionPreview from "./components/preview/DefinitionPreview";
import PrimerPage from "./components/primer/PrimerPage";
import ScrollbarMarkup from "./components/scrollbar/ScrollbarMarkup";
import FindBar, { FindQuery } from "./components/search/FindBar";
import logger from "./logging";
import * as selectors from "./selectors";
import { matchingSymbols } from "./selectors";
import {
  ConfigurableSetting,
  CONFIGURABLE_SETTINGS,
  getSettings,
  GlossStyle,
} from "./settings";
import skimmingData from "./skimmingData/facets.json";
import {
  Entities,
  KnownEntityType,
  Pages,
  PaperId,
  State,
  SymbolFilters,
} from "./state";
import "./style/index.less";
import {
  DocumentLoadedEvent,
  PageRenderedEvent,
  PDFViewerApplication,
} from "./types/pdfjs-viewer";
import * as stateUtils from "./utils/state";
import * as uiUtils from "./utils/ui";

interface Props {
  paperId?: PaperId;
  presets?: string[];
  context?: any;
}

export default class ScholarReader extends React.PureComponent<Props, State> {
  constructor(props: Props) {
    super(props);

    const settings = getSettings(props.presets);
    const loggingContext: any = { ...props.context };
    if (props.presets) {
      loggingContext.presets = props.presets;
    }
    if (props.paperId) {
      loggingContext.paperId = props.paperId;
    }
    logger.setContext(loggingContext);

    this.state = {
      entities: null,
      lazyPapers: new Map(),

      pages: null,
      pdfViewerApplication: null,
      pdfDocument: null,
      pdfViewer: null,

      controlPanelShowing: false,

      areCitationsLoading: false,

      selectedAnnotationIds: [],
      selectedAnnotationSpanIds: [],
      selectedEntityIds: [],
      multiselectEnabled: false,
      jumpTarget: null,

      textSelection: null,
      textSelectionChangeMs: null,

      isFindActive: false,
      findMode: null,
      findActivationTimeMs: null,
      findQuery: null,
      findMatchIndex: null,
      findMatchCount: null,
      findMatchedEntities: null,
      drawerMode: "closed",
      drawerContentType: null,
      snackbarMode: "closed",
      snackbarActivationTimeMs: null,
      snackbarMessage: null,

      entityCreationAreaSelectionMethod: "text-selection",
      entityCreationType: "term",
      propagateEntityEdits: true,

      skimOpacity: 0.3,
      showSkimmingAnnotations: true,
      showSkimmingAnnotationColors: true,

      currentHighlightId: null,
      facetedHighlights: [],
      sections: [],
      highlightsBySection: {},
      allHighlightsById: {},
      selectedFacets: this.getAvailableFacets(),
      hiddenFacetedHighlights: [],
      numHighlightMultiplier: {
        objective: 1.0,
        novelty: 1.0,
        method: 0.8,
        result: 0.8,
      },

      highlightQuantity:
        localStorage.getItem("highlightQuantity") !== null
          ? +localStorage.getItem("highlightQuantity")!
          : 80,

      ...settings,
    };
  }

  getAvailableFacets = () => {
    return ["objective", "novelty", "method", "result"];
  };

  toggleControlPanelShowing = (): void => {
    this.setState((prevState) => ({
      controlPanelShowing: !prevState.controlPanelShowing,
    }));
  };

  toggleAnnotationHints = (): void => {
    this.setState((prevState) => ({
      annotationHintsEnabled: !prevState.annotationHintsEnabled,
    }));
  };

  toggleSkimmingAnnotations = (): void => {
    if (this.state.showSkimmingAnnotations) {
      logger.log("debug", "deactivate-skimming-mode");
    } else {
      logger.log("debug", "activate-skimming-mode");
    }
    this.setState((prevState) => ({
      showSkimmingAnnotations: !prevState.showSkimmingAnnotations,
      drawerMode: "closed",
    }));
  };

  setAnnotationHintsEnabled = (enabled: boolean): void => {
    this.setState({ annotationHintsEnabled: enabled });
  };

  setGlossStyle = (style: GlossStyle): void => {
    this.setState({ glossStyle: style });
  };

  closeControlPanel = (): void => {
    this.setState({ controlPanelShowing: false });
  };

  handleChangeSetting = (setting: ConfigurableSetting, value: any): void => {
    this.setState({
      [setting.key]: value,
    } as State);
  };

  setTextSelection = (selection: Selection | null): void => {
    this.setState({
      textSelection: selection,
      textSelectionChangeMs: Date.now(),
    });
  };

  selectEntity = (id: string): void => {
    this.selectEntityAnnotation(id);
  };

  selectEntityAnnotation = (
    entityId: string,
    annotationId?: string,
    annotationSpanId?: string
  ): void => {
    logger.log("debug", "select-entity", {
      entityId,
      annotationId,
      annotationSpanId,
    });

    this.setState((prevState) => {
      const prevEntities = prevState.entities;
      if (prevEntities === null) {
        return {};
      }

      const selectedEntityIds = prevState.multiselectEnabled
        ? [...prevState.selectedEntityIds]
        : [];
      const selectedAnnotationIds = prevState.multiselectEnabled
        ? [...prevState.selectedAnnotationIds]
        : [];
      const selectedAnnotationSpanIds = prevState.multiselectEnabled
        ? [...prevState.selectedAnnotationSpanIds]
        : [];
      if (selectedEntityIds.indexOf(entityId) === -1) {
        selectedEntityIds.push(entityId);
      }
      if (annotationId && selectedAnnotationIds.indexOf(annotationId) === -1) {
        selectedAnnotationIds.push(annotationId);
      }
      if (
        annotationSpanId &&
        selectedAnnotationSpanIds.indexOf(annotationSpanId) === -1
      ) {
        selectedAnnotationSpanIds.push(annotationSpanId);
      }

      logger.log("debug", "selection-updated", {
        selectedEntityIds,
        selectedAnnotationIds,
        selectedAnnotationSpanIds,
      });

      /*
       * The default behavior is to just update the selection. If the selection is a,
       * searchable type of entity, however, start a search.
       */
      const entityType = prevEntities.byId[entityId].type;
      if (["symbol", "term"].indexOf(entityType) === -1) {
        return {
          selectedEntityIds,
          selectedAnnotationIds,
          selectedAnnotationSpanIds,
          jumpTarget: null,
        } as State;
      }

      /*
       * If this is a term, start a term search.
       */
      if (entityType === "term") {
        const termIds = selectedEntityIds.filter(
          (id) => prevEntities.byId[id].type === "term"
        );
        const matching = selectors.matchingTerms(termIds, prevEntities);
        const matchCount = matching.length;
        const matchIndex = matching.indexOf(entityId);
        logger.log("debug", "starting-term-search", { matchIndex, matchCount });
        return {
          selectedEntityIds,
          selectedAnnotationIds,
          selectedAnnotationSpanIds,
          isFindActive: true,
          findMode: "term",
          findActivationTimeMs: Date.now(),
          findQuery: prevEntities.byId[entityId],
          findMatchCount: matchCount,
          findMatchIndex: matchIndex,
          findMatchedEntities: matching,
          jumpTarget: null,
        } as State;
      }

      /*
       * If this is a symbol, start a symbol search.
       */
      const symbolIds = selectedEntityIds.filter(
        (id) => prevEntities.byId[id].type === "symbol"
      );
      const matching = matchingSymbols(symbolIds, prevEntities);
      const matchCount = matching.length;
      const matchIndex = matching.indexOf(entityId);
      logger.log("debug", "starting-symbol-search", { matchIndex, matchCount });
      return {
        selectedEntityIds,
        selectedAnnotationIds,
        selectedAnnotationSpanIds,
        isFindActive: true,
        findMode: "symbol",
        findActivationTimeMs: Date.now(),
        findQuery: {
          byId: {
            [entityId]: {
              symbol: prevEntities.byId[entityId],
              active: true,
            },
          },
          all: [entityId],
        } as FindQuery,
        findMatchCount: matchCount,
        findMatchIndex: matchIndex,
        findMatchedEntities: matching,
        jumpTarget: null,
      } as State;
    });
  };

  clearEntitySelection = (): void => {
    logger.log("debug", "clear-entity-selection");

    /*
     * If interaction with entities is currently turned off, then nothing was selected in the
     * first place. Don't change the state, incase the selected annotation list or the jump
     * target contains important highlights that shouldn't be dismissed.
     */
    if (!this.state.annotationInteractionEnabled) {
      return;
    }

    if (this.state.findMode === "symbol" || this.state.findMode === "term") {
      this.closeFindBar();
    }
    this.setState({
      selectedAnnotationIds: [],
      selectedAnnotationSpanIds: [],
      selectedEntityIds: [],
      jumpTarget: null,
    });
  };

  setEntityCreationType = (type: KnownEntityType): void => {
    this.setState({ entityCreationType: type });
  };

  setEntityCreationAreaSelectionMethod = (
    method: AreaSelectionMethod
  ): void => {
    this.setState({ entityCreationAreaSelectionMethod: method });
  };

  createEntity = async (data: EntityCreateData): Promise<string | null> => {
    if (this.props.paperId !== undefined) {
      const createdEntity = await api.postEntity(this.props.paperId.id, data);
      if (createdEntity !== null) {
        this.setState((prevState) => ({
          /*
           * Add the entity to memory
           */
          entities:
            prevState.entities !== null
              ? stateUtils.add(
                  prevState.entities,
                  createdEntity.id,
                  createdEntity
                )
              : null,
          /*
           * Select the new entity
           */
          selectedEntityIds: [createdEntity.id],
        }));
        return createdEntity.id;
      }
    }
    return null;
  };

  createParentSymbol = async (childSymbols: Symbol[]): Promise<boolean> => {
    /*
     * Parent bounding box is the union of child bounding boxes.
     */
    const childBoxes = childSymbols
      .map((c) => c.attributes.bounding_boxes)
      .flat();
    if (childBoxes.length === 0) {
      return false;
    }
    const left = Math.min(...childBoxes.map((b) => b.left));
    const top = Math.min(...childBoxes.map((b) => b.top));
    const right = Math.max(...childBoxes.map((b) => b.left + b.width));
    const bottom = Math.max(...childBoxes.map((b) => b.top + b.height));
    const parentBox = {
      left,
      top,
      width: right - left,
      height: bottom - top,
      page: childBoxes[0].page,
      source: "human-annotation",
    };

    /*
     * Transfer TeX and sentence references from children to parent. Attempt to create
     * parent TeX by removing TeX markers (e.g., leading and training '$') from child
     * TeX and then concatenating all child TeX.
     */
    const allChildTex = childSymbols
      .map((s) => s.attributes.tex || "")
      .map((tex) => tex.replace(/^\$*/, "").replace(/\$*$/, ""))
      .join(" ");
    const createEntityData = createCreateEntityDataWithBoxes(
      [parentBox],
      "symbol",
      allChildTex
    );
    const childIds = childSymbols.map((c) => c.id);
    const sentenceId =
      childSymbols
        .map((c) => c.relationships.sentence.id)
        .filter((id) => id !== null)[0] || null;
    createEntityData.relationships = {
      ...createEntityData.relationships,
      children: childIds.map((id) => ({ type: "symbol", id })),
      sentence: { type: "sentence", id: sentenceId },
    };

    /*
     * Create parent symbol.
     */
    const parentId = await this.createEntity(createEntityData);
    if (parentId === null) {
      return false;
    }

    /*
     * Update children to reference the parent.
     */
    for (const child of childSymbols) {
      const updateData = {
        id: child.id,
        type: "symbol",
        attributes: {
          source: "human-annotation",
        },
        relationships: {
          parent: { type: "symbol", id: parentId },
        },
      } as EntityUpdateData;
      const success = await this.updateEntity(child, updateData, false);
      if (!success) {
        return false;
      }
    }

    return true;
  };

  updateEntity = async (
    entity: Entity,
    updateData: EntityUpdateData,
    propagateEdits?: boolean
  ): Promise<boolean> => {
    const { paperId } = this.props;
    if (paperId === undefined) {
      return false;
    }

    /*
     * By default, only update this one entity. If edits are supposed to be
     * propagated to other matching entities, build a list matching entities to update.
     */
    const entitiesToPatch = [entity.id];
    const entities = this.state.entities;
    if (
      (propagateEdits === true ||
        (propagateEdits === undefined && this.state.propagateEntityEdits)) &&
      entities !== null
    ) {
      entitiesToPatch.push(
        ...entities.all
          .map((id) => entities.byId[id])
          .filter((e) => {
            if (e.id === entity.id) {
              return false;
            } else if (isSymbol(entity) && isSymbol(e)) {
              return entity.attributes.tex === e.attributes.tex;
            } else if (isTerm(entity) && isTerm(e)) {
              return entity.attributes.name === e.attributes.name;
            }
            return false;
          })
          .map((e) => e.id)
      );
    }

    /*
     * Patch entities, saving which ones were successfully updated.
     */
    const patchedEntities = await Promise.all(
      entitiesToPatch.map((id) =>
        api.patchEntity(paperId.id, { ...updateData, id })
      )
    ).then((successes) =>
      successes
        .map((success, i) => (success ? entitiesToPatch[i] : undefined))
        .filter((id) => id !== undefined)
        .map((id) => id as string)
    );

    /*
     * Update entities in memory. Only update those that were successfully patched.
     */
    this.setState((prevState) => {
      const prevEntities = prevState.entities;
      if (prevEntities !== null) {
        let nextEntities = { ...prevEntities };
        patchedEntities.forEach((id) => {
          const prevEntity = prevEntities.byId[id];
          const updated = {
            ...prevEntity,
            attributes: { ...prevEntity.attributes, ...updateData.attributes },
            relationships: {
              ...prevEntity.relationships,
              ...updateData.relationships,
            },
          };
          nextEntities = stateUtils.update(nextEntities, id, updated);
        });
        return {
          entities: nextEntities,
        };
      }
      return { entities: prevState.entities };
    });

    const completeSuccess = entitiesToPatch.length === patchedEntities.length;
    return completeSuccess;
  };

  deleteEntity = async (id: string): Promise<boolean> => {
    if (this.props.paperId !== undefined) {
      const result = await api.deleteEntity(this.props.paperId.id, id);
      if (result) {
        this.setState((prevState) => {
          /*
           * Delete the entity from memory.
           */
          const updatedEntities =
            prevState.entities !== null
              ? stateUtils.del(prevState.entities, id)
              : null;

          /*
           * Deselect the entity if it's currently selected.
           */
          let selectionState;
          if (prevState.selectedEntityIds.indexOf(id) !== -1) {
            selectionState = {
              selectedEntityIds: [],
              selectedAnnotationIds: [],
              selectedAnnotationSpanIds: [],
            };
          } else {
            selectionState = {
              selectedEntityIds: prevState.selectedEntityIds,
              selectedAnnotationIds: prevState.selectedAnnotationIds,
              selectedAnnotationSpanIds: prevState.selectedAnnotationSpanIds,
            };
          }

          return { ...selectionState, entities: updatedEntities };
        });
        return true;
      }
    }
    return false;
  };

  showSnackbarMessage = (message: string): void => {
    this.setState({
      snackbarMode: "open",
      snackbarActivationTimeMs: Date.now(),
      snackbarMessage: message,
    });
  };

  closeSnackbar = (): void => {
    this.setState({
      snackbarMode: "closed",
      snackbarActivationTimeMs: null,
      snackbarMessage: null,
    });
  };

  openDrawer = (drawerContentType: DrawerContentType): void => {
    logger.log("debug", "request-open-drawer", { drawerContentType });
    this.setState({
      drawerMode: "open",
      drawerContentType,
    });
  };

  openDrawerWithFacets = () => {
    this.openDrawer("facets");
  };

  closeDrawer = (): void => {
    logger.log("debug", "close-drawer");
    this.setState({ drawerMode: "closed" });
  };

  toggleDrawer = (drawerContentType: DrawerContentType): void => {
    if (this.state.drawerMode === "closed") {
      this.openDrawer(drawerContentType);
    } else {
      this.closeDrawer();
    }
  };

  setMultiselectEnabled = (enabled: boolean): void => {
    this.setState({ multiselectEnabled: enabled });
  };

  setPropagateEntityEdits = (propagate: boolean): void => {
    this.setState({
      propagateEntityEdits: propagate,
    });
  };

  startTextSearch = (): void => {
    logger.log("debug", "start-text-search");
    this.setState({
      isFindActive: true,
      findActivationTimeMs: Date.now(),
      findMode: "pdfjs-builtin-find",
    });
  };

  setFindMatchCount = (findMatchCount: number | null): void => {
    logger.log("debug", "find-match-count-updated", { count: findMatchCount });
    this.setState({ findMatchCount });
  };

  setFindMatchIndex = (findMatchIndex: number | null): void => {
    logger.log("debug", "find-match-index-updated", {
      index: findMatchIndex,
      count: this.state.findMatchCount,
    });
    this.setState((state) => {
      if (
        (state.findMode === "symbol" || state.findMode === "term") &&
        state.findMatchedEntities !== null &&
        findMatchIndex !== null &&
        state.entities !== null
      ) {
        const entityId = state.findMatchedEntities[findMatchIndex];
        this.jumpToEntity(entityId);
      }
      return { findMatchIndex };
    });
  };

  setFindQuery = (findQuery: FindQuery): void => {
    this.setState((state) => {
      if (state.findMode === "symbol" && state.entities !== null) {
        const selectedSymbolIds = selectors.symbolIds(
          state.entities,
          state.selectedEntityIds
        );
        if (selectedSymbolIds.length === 0) {
          return {};
        }

        const symbolFilters = findQuery as SymbolFilters;
        const filterList =
          symbolFilters !== null
            ? Object.values(symbolFilters.byId)
            : undefined;
        const matching = matchingSymbols(
          selectedSymbolIds,
          state.entities,
          filterList
        );
        const matchCount = matching.length;
        const lastSelectedSymbolId =
          selectedSymbolIds[selectedSymbolIds.length - 1];
        const matchIndex = matching.indexOf(lastSelectedSymbolId);
        return {
          findQuery,
          findMatchCount: matchCount,
          findMatchIndex: matchIndex,
          findMatchedEntities: matching,
        } as State;
      }
      return { findQuery } as State;
    });
  };

  closeFindBar = (): void => {
    logger.log("debug", "find-close");
    this.setState({
      isFindActive: false,
      findActivationTimeMs: null,
      findMode: null,
      findQuery: null,
      findMatchCount: null,
      findMatchIndex: null,
      findMatchedEntities: null,
    });
  };

  componentDidMount() {
    waitForPDFViewerInitialization().then((application) => {
      logger.log("debug", "application-loaded");
      /*
       * Tell pdf.js not to use default find functionality, but instead to forward find events
       * to external services. The events are intercepted in 'FindBar'.
       */
      application.externalServices.supportsIntegratedFind = true;

      this.setState({ pdfViewerApplication: application });
      this.subscribeToPDFViewerStateChanges(application);
    });
    this.loadDataFromApi();

    document.addEventListener("keydown", (event) => {
      if (uiUtils.isKeypressShiftTab(event)) {
        logger.log("debug", "navigate-next-highlight");
        event.preventDefault();
        if (this.state.facetedHighlights.length > 0) {
          this.moveToPreviousHighlight();
        }
      } else if (uiUtils.isKeypressTab(event)) {
        logger.log("debug", "navigate-prev-highlight");
        event.preventDefault();
        if (this.state.facetedHighlights.length > 0) {
          this.moveToNextHighlight();
        }
      }
    });

    if (this.props.paperId !== undefined) {
      // This sets the proper highlight level based on user settings
      // and initializes the faceted highlights
      this.handleHighlightQuantityChanged(this.state.highlightQuantity);
    }
  }

  moveToNextHighlight = () => {
    const activeHighlights = this.filterFacetedHighlights(
      this.state.facetedHighlights
    );
    const highlightIds = activeHighlights.map((x) => x.id);
    const numHighlights = activeHighlights.length;
    let nextId = "";
    if (this.state.currentHighlightId !== null) {
      const currIdx = highlightIds.indexOf(this.state.currentHighlightId);
      const nextIdx = (currIdx + 1) % numHighlights;
      nextId = highlightIds[nextIdx];
    } else {
      nextId = highlightIds[0];
    }
    uiUtils.removeClassFromElementsByClassname("selected");
    uiUtils.addClassToElementsByClassname(`highlight-${nextId}`, "selected");
    this.jumpToHighlight(nextId);
  };

  moveToPreviousHighlight = () => {
    const activeHighlights = this.filterFacetedHighlights(
      this.state.facetedHighlights
    );
    const highlightIds = activeHighlights.map((x) => x.id);
    const numHighlights = activeHighlights.length;
    let nextId = "";
    if (this.state.currentHighlightId !== null) {
      const currIdx = highlightIds.indexOf(this.state.currentHighlightId);
      const nextIdx = (numHighlights + currIdx - 1) % numHighlights;
      nextId = highlightIds[nextIdx];
    } else {
      nextId = highlightIds[numHighlights - 1];
    }
    uiUtils.removeClassFromElementsByClassname("selected");
    uiUtils.addClassToElementsByClassname(`highlight-${nextId}`, "selected");
    this.jumpToHighlight(nextId);
  };

  setCurrentHighlightId = (d: FacetedHighlight) => {
    this.setState({
      currentHighlightId: d.id,
    });
  };

  initFacetedHighlights = () => {
    const sections = Object(skimmingData)[this.props.paperId!.id]["sections"];

    const facetToColorMap: {
      [label: string]: string;
    } = uiUtils.getFacetColors();

    let facetedHighlights = Object(skimmingData)[this.props.paperId!.id][
      "highlights"
    ].map((x: any) => ({
      id: x.id,
      text: x.text,
      section: x.section,
      label: x.label,
      score: x.score,
      boxes: x.boxes,
      tagLocation: x.boxes[0],
      color: this.state.showSkimmingAnnotationColors
        ? facetToColorMap[x.label] ?? facetToColorMap["highlight"]
        : facetToColorMap["highlight"],
    }));

    // Disable faceted highlights in abstract
    facetedHighlights = facetedHighlights.filter(
      (h: FacetedHighlight) => h.section.toLowerCase() !== "abstract"
    );

    // Save all faceted highlights before we further filtering
    const allHighlightsById = this.makeHighlightByIdMap(facetedHighlights);
    const highlightsBySection = facetedHighlights.reduce(
      (acc: { [section: string]: FacetedHighlight[] }, h: FacetedHighlight) => {
        // The section attribute contains (when they exist) section, subsection, and subsubsection header data, delimited by "@@".
        const long_section = h.section;
        const section = long_section.split("@@").pop()?.trim() || "";
        if (!acc[section]) {
          acc[section] = [];
        }
        acc[section].push(h);
        return acc;
      },
      {}
    );

    // Filter highlights at score threshold
    facetedHighlights = facetedHighlights.filter(
      (h: FacetedHighlight) => h.score >= 0.9
    );

    // Add highlights for the four facets
    facetedHighlights = [
      ...this.getNoveltyHighlights(facetedHighlights),
      ...this.getObjectiveHighlights(facetedHighlights),
      ...this.getMethodHighlights(facetedHighlights),
      ...this.getResultHighlights(facetedHighlights),
    ];

    this.setState({
      facetedHighlights: uiUtils.sortFacetedHighlights(facetedHighlights),
      highlightsBySection: highlightsBySection,
      allHighlightsById: allHighlightsById,
      sections: sections,
    });
  };

  filterFacetedHighlights = (facetedHighlights: FacetedHighlight[]) => {
    return facetedHighlights
      .filter((x: FacetedHighlight) =>
        this.state.selectedFacets.includes(x.label)
      )
      .filter((x: FacetedHighlight) => {
        const hiddenIds = this.state.hiddenFacetedHighlights.map((d) => d.id);
        return !hiddenIds.includes(x.id);
      });
  };

  makeHighlightByIdMap = (facetedHighlights: FacetedHighlight[]) => {
    const allHighlightsById = facetedHighlights.reduce(
      (acc: { [id: string]: FacetedHighlight }, d: FacetedHighlight) => {
        acc[d.id] = d;
        return acc;
      },
      {}
    );
    return allHighlightsById;
  };

  getNoveltyHighlights = (highlights: FacetedHighlight[]) => {
    let novelty = highlights.filter((r) => r.label === "novelty");
    return novelty
      .sort((x1, x2) => x2.score - x1.score)
      .slice(
        0,
        Math.round(
          this.state.numHighlightMultiplier["novelty"] * novelty.length
        )
      );
  };

  getMethodHighlights = (highlights: FacetedHighlight[]) => {
    const methods = highlights.filter((r) => r.label === "method");
    return methods
      .sort((x1, x2) => x2.score - x1.score)
      .slice(
        0,
        Math.round(this.state.numHighlightMultiplier["method"] * methods.length)
      );
  };

  getResultHighlights = (highlights: FacetedHighlight[]) => {
    const results = highlights.filter((r) => {
      const hasCitation = new RegExp(/\[.*\d.*\]/).test(r.text);
      return r.label === "result" && !hasCitation;
    });

    return results
      .sort((x1, x2) => x2.score - x1.score)
      .slice(
        0,
        Math.round(this.state.numHighlightMultiplier["result"] * results.length)
      );
  };

  getObjectiveHighlights = (highlights: FacetedHighlight[]) => {
    const objectives = highlights.filter((r) => r.label === "objective");
    return objectives
      .sort((x) => x.score)
      .reverse()
      .slice(
        0,
        Math.round(
          this.state.numHighlightMultiplier["objective"] * objectives.length
        )
      );
  };

  selectFacet = (facet: string) => {
    if (facet === "all") {
      this.setState({ selectedFacets: this.getAvailableFacets() });
    } else {
      this.filterToFacet(facet);
    }
  };

  filterToFacet = (facet: string) => {
    if (this.state.selectedFacets.includes(facet)) {
      this.setState({
        selectedFacets: this.state.selectedFacets.filter((d) => d !== facet),
      });
    } else {
      this.setState((prevState) => ({
        selectedFacets: [...prevState.selectedFacets, facet],
      }));
    }
  };

  handleHighlightQuantityChanged = (value: number) => {
    localStorage.setItem("highlightQuantity", value.toString());
    const facets = ["result", "method", "objective", "novelty"];
    this.setState((prevState) => {
      let newHighlightMultiplier = prevState.numHighlightMultiplier;

      facets.forEach((facet: string) => {
        // Handle objective and novelty highlights a bit differently (proritize showing them)
        newHighlightMultiplier = {
          ...newHighlightMultiplier,
          [facet]: ["objective", "novelty"].includes(facet)
            ? (value / 100) * 1.5
            : value / 100,
        };
      });

      logger.log("debug", "increase-num-highlights", {
        highlightQuantity: value,
      });

      let newSelectedFacets = prevState.selectedFacets;
      facets.forEach((facet: string) => {
        if (prevState.numHighlightMultiplier[facet] === 0) {
          newSelectedFacets.push(facet);
        }
      });

      return {
        highlightQuantity: value,
        numHighlightMultiplier: newHighlightMultiplier,
        selectedFacets: newSelectedFacets,
      };
    }, this.initFacetedHighlights);
  };

  onScrollbarMarkClicked = (id: string) => {
    this.jumpToHighlight(id);
    setTimeout(() => {
      this.selectSnippetInDrawer(this.state.allHighlightsById[id]);
    }, 200);
  };

  hideHighlight = (d: FacetedHighlight) => {
    this.setState((prevState) => ({
      hiddenFacetedHighlights: [...prevState.hiddenFacetedHighlights, d],
    }));
  };

  showAllHighlightsForSection = (section: string, active: boolean) => {
    if (active) {
      const existingIds = this.state.facetedHighlights.map((h) => h.id);
      const newHighlightsToShow = this.state.highlightsBySection[
        section
      ].filter((h: FacetedHighlight) => !existingIds.includes(h.id));
      console.log(newHighlightsToShow);
      this.setState((prevState) => ({
        facetedHighlights: [
          ...prevState.facetedHighlights,
          ...newHighlightsToShow,
        ],
      }));
    } else {
      this.initFacetedHighlights();
    }
  };

  subscribeToPDFViewerStateChanges = (
    pdfViewerApplication: PDFViewerApplication
  ): void => {
    const { eventBus, pdfDocument, pdfViewer } = pdfViewerApplication;

    if (pdfDocument !== null) {
      this.setState({ pdfDocument });
    }
    if (pdfViewer !== null) {
      this.setState({ pdfViewer });
    }
    eventBus.on("documentloaded", (eventData: DocumentLoadedEvent) => {
      this.setState({ pdfDocument: eventData.source });
      setTimeout(() => {
        (window.PDFViewerApplication as any).pdfSidebar.switchView(0);
      }, 1);
    });

    /*
     * TODO(andrewhead): Do we need to add pages that are *already loaded* at initialization time
     * to the state? Or will 'pagerendered' always run after this component is mounted?
     */
    eventBus.on("pagerendered", (eventData: PageRenderedEvent) => {
      this.setState({
        pdfDocument: pdfViewerApplication.pdfDocument,
        pages: {
          ...this.state.pages,
          [uiUtils.getPageNumber(eventData.source)]: {
            timeOfLastRender: eventData.timestamp,
            view: eventData.source,
          },
        },
      });
    });
  };

  loadDataFromApi = async (): Promise<void> => {
    if (
      this.props.paperId !== undefined &&
      this.props.paperId.type === "arxiv"
    ) {
      const loadingStartTime = performance.now();
      const entities = await api.getDedupedEntities(
        this.props.paperId.id,
        true
      );
      this.setState({
        entities: stateUtils.createRelationalStoreFromArray(entities, "id"),
      });

      const citationS2Ids = entities
        .filter(isCitation)
        .map((c) => c.attributes.paper_id)
        .filter((id) => id !== null)
        .map((id) => id as string);

      if (window.heap) {
        const loadingTimeMS = Math.round(performance.now() - loadingStartTime);
        window.heap.track("paper-loaded", {
          loadingTimeMS,
          numEntities: entities.length,
          numCitations: citationS2Ids.length,
        });
      }
    }
  };

  cachePaper = (paper: Paper, cb?: () => void): void => {
    const paperMap = new Map(this.state.lazyPapers);
    paperMap.set(paper.s2Id, paper);
    this.setState(
      {
        lazyPapers: paperMap,
      },
      cb
    );
  };

  jumpToEntityWithBackMessage = (id: string): void => {
    const success = this.jumpToEntity(id);

    if (success && !this._backButtonHintShown) {
      this.showSnackbarMessage(
        "Resume where you left by pressing the browser '←' button."
      );
      // this._backButtonHintShown = true;
    }
  };

  jumpToEntity = (id: string): boolean => {
    /*
     * In a past version, these offsets were based roughly off those in the pdf.js "find" functionality:
     * https://github.com/mozilla/pdf.js/blob/16ae7c6960c1296370c1600312f283a68e82b137/web/pdf_find_controller.js#L28-L29
     */
    const SCROLL_OFFSET_X = -200;
    const SCROLL_OFFSET_Y = +100;

    const { pdfViewerApplication, pdfViewer, pages, entities } = this.state;

    if (
      entities === null ||
      entities.byId[id] === undefined ||
      entities.byId[id].attributes.bounding_boxes.length === 0 ||
      pdfViewerApplication === null ||
      pdfViewer === null ||
      pages === null ||
      Object.values(pages).length === 0
    ) {
      return false;
    }

    const dest = entities.byId[id].attributes.bounding_boxes[0];

    /*
     * Use the size of the first loaded page to map from ratio-based entity
     * dimensions and absolute positions on the page. Note that this mapping will not work
     * if pages in a PDF have different dimensions.
     */
    const page = Object.values(pages)[0];
    const { left, top } = uiUtils.convertBoxToPdfCoordinates(page.view, dest);

    /*
     * Scroll to the destination. Use the 'navigateTo', which will save
     * the current location to history so that when a user clicks the 'Back' button, it takes
     * them back to where they were before.
     */
    pdfViewerApplication.pdfLinkService.navigateTo([
      dest.page,
      { name: "XYZ" },
      left + SCROLL_OFFSET_X,
      top + SCROLL_OFFSET_Y,
    ]);

    /*
     * Store the position that the paper has jumped to.
     */
    this.setState({
      jumpTarget: id,
    });

    return true;
  };

  jumpToHighlight = (id: string) => {
    const SCROLL_OFFSET_X = -200;
    const SCROLL_OFFSET_Y = +100;

    const {
      pdfViewerApplication,
      pdfViewer,
      pages,
      allHighlightsById,
    } = this.state;

    if (
      pdfViewerApplication === null ||
      pdfViewer === null ||
      pages === null ||
      Object.values(pages).length === 0
    ) {
      return false;
    }

    const dest = allHighlightsById[id].boxes[0];
    const page = Object.values(pages)[0];
    const { left, top } = uiUtils.convertBoxToPdfCoordinates(page.view, dest);

    /*
     * Scroll to the destination. Use the 'navigateTo', which will save
     * the current location to history so that when a user clicks the 'Back' button, it takes
     * them back to where they were before.
     */
    pdfViewerApplication.pdfLinkService.navigateTo([
      dest.page,
      { name: "XYZ" },
      left + SCROLL_OFFSET_X,
      top + SCROLL_OFFSET_Y,
    ]);

    /*
     * Store the position that the paper has jumped to.
     */
    this.setState({
      jumpTarget: id,
      currentHighlightId: id,
    });

    return true;
  };

  selectSnippetInDrawer = (selection: FacetedHighlight | null) => {
    let elementToSelectClass;
    if (selection !== null) {
      elementToSelectClass = `facet-snippet-${selection.id}`;
    }

    if (elementToSelectClass !== undefined) {
      uiUtils.removeClassFromElementsByClassname("selected");
      const facetSnippet = document.querySelector(`.${elementToSelectClass}`);
      if (facetSnippet !== null) {
        facetSnippet.classList.add("selected");
        facetSnippet.scrollIntoView({
          block: "center",
          behavior: "smooth",
        });
      }
    }
  };

  exportSkimmingAnnotations = () => {
    const highlightsByFacet = this.state.facetedHighlights.reduce(
      (acc: { [facet: string]: FacetedHighlight[] }, d: FacetedHighlight) => {
        return { ...acc, [d.label]: [...(acc[d.label] || []), d] };
      },
      {}
    );
    const facetColors = uiUtils.getFacetColors();
    const facetDisplayNames = uiUtils.getFacetDisplayNames();
    const paperId = this.props.paperId?.id;

    const doc = new jsPDF();
    const highlightsList = document.createElement("ul");
    highlightsList.style.width = "160px";
    highlightsList.style.listStyleType = "none";
    Object.entries(highlightsByFacet).map(([facet, highlights]) => {
      const facetHeaderText = document.createElement("span");
      facetHeaderText.style.fontSize = "8px";
      facetHeaderText.style.color = facetColors[facet];
      facetHeaderText.appendChild(
        document.createTextNode(facetDisplayNames[facet])
      );
      highlightsList.appendChild(facetHeaderText);
      highlights.forEach((highlight) => {
        let li = document.createElement("li");
        li.innerText = `${highlight.text} (Page ${highlight.boxes[0].page})`;
        li.style.fontSize = "4px";
        li.style.overflowWrap = "break-word";
        li.style.margin = "4px 0";
        highlightsList.appendChild(li);
      });
    });

    doc.html(highlightsList, {
      callback: (doc: any) => {
        doc.save(`annotations-${paperId}.pdf`);
      },
      autoPaging: "text",
      margin: [25, 15, 25, 25],
      width: doc.internal.pageSize.getWidth(),
      windowWidth: 200,
      html2canvas: {
        scale: 1,
      },
    });
  };

  handleSkimmingAnnotationColorsChanged = (showMultiColor: boolean) => {
    const facetToColorMap: {
      [label: string]: string;
    } = uiUtils.getFacetColors();

    const facetedHighlights = this.state.facetedHighlights.map((x) => {
      x.color =
        showMultiColor && Object.keys(facetToColorMap).includes(x.label)
          ? facetToColorMap[x.label]
          : facetToColorMap["highlight"];
      return x;
    });

    this.setState({
      facetedHighlights: facetedHighlights,
      allHighlightsById: this.makeHighlightByIdMap(facetedHighlights),
      showSkimmingAnnotationColors: showMultiColor,
    });
  };

  render() {
    let findMatchEntityId: string | null = null;
    if (
      this.state.findMatchedEntities !== null &&
      this.state.findMatchIndex !== null &&
      this.state.findMatchIndex < this.state.findMatchedEntities.length
    ) {
      findMatchEntityId = this.state.findMatchedEntities[
        this.state.findMatchIndex
      ];
    }

    if (
      !this._jumpedToInitialFocus &&
      this.state.pages !== null &&
      Object.keys(this.state.pages).length > 0 &&
      this.state.entities !== null
    ) {
      if (this.state.initialFocus !== null) {
        this.jumpToEntity(this.state.initialFocus);
        logger.log("debug", "jump-page-to-initial-focus", {
          entityId: this.state.initialFocus,
        });
      }
      this._jumpedToInitialFocus = true;
    }

    let facetedHighlights = this.filterFacetedHighlights(
      this.state.facetedHighlights
    );

    return (
      <>
        {this.state.pdfViewerApplication !== null &&
        this.state.pdfViewer !== null ? (
          <>
            {/* Render the widgets and event handlers for the entire app and viewer containers. */}
            <AppOverlay
              appContainer={document.body}
              snackbarMode={this.state.snackbarMode}
              snackbarActivationTimeMs={this.state.snackbarActivationTimeMs}
              snackbarMessage={this.state.snackbarMessage}
              handleToggleControlPanelShowing={this.toggleControlPanelShowing}
              handleSetMultiselectEnabled={this.setMultiselectEnabled}
              handleStartTextSearch={this.startTextSearch}
              handleTerminateSearch={this.closeFindBar}
              handleCloseSnackbar={this.closeSnackbar}
              handleCloseDrawer={this.closeDrawer}
            />
            <PdfjsToolbarLeft>
              <Legend />
            </PdfjsToolbarLeft>
            <PdfjsToolbarRight>
              {this.state.showSkimmingAnnotations &&
                this.state.facetedHighlights && (
                  <button
                    onClick={this.exportSkimmingAnnotations}
                    className="toolbarButton hiddenLargeView pdfjs-toolbar__button"
                  >
                    <span>Export Annotations</span>
                  </button>
                )}

              <button
                onClick={this.toggleSkimmingAnnotations}
                className="toolbarButton hiddenLargeView pdfjs-toolbar__button"
              >
                <span>
                  {this.state.showSkimmingAnnotations
                    ? "Disable skimming"
                    : "Enable skimming"}
                </span>
              </button>
              {/* <button
                onClick={this.toggleControlPanelShowing}
                className="toolbarButton hiddenLargeView pdfjs-toolbar__button"
              >
                <span>Customize UI</span>
              </button> */}
            </PdfjsToolbarRight>
            <ViewerOverlay
              pdfViewer={this.state.pdfViewer}
              handleSetTextSelection={this.setTextSelection}
              handleClearEntitySelection={this.clearEntitySelection}
            >
              <div
                className={classNames("scholar-reader-toolbar-container", {
                  "snackbar-showing": this.state.snackbarMode === "open",
                })}
              >
                {this.state.controlPanelShowing ? (
                  <MainControlPanel
                    className="scholar-reader-toolbar"
                    handleClose={this.closeControlPanel}
                  >
                    {CONFIGURABLE_SETTINGS.map((setting) => (
                      <Control
                        key={setting.label}
                        setting={setting}
                        value={this.state[setting.key]}
                        handleChange={this.handleChangeSetting}
                      />
                    ))}
                  </MainControlPanel>
                ) : null}
                {this.state.isFindActive &&
                this.state.findActivationTimeMs !== null &&
                (this.state.findMode !== "symbol" ||
                  this.state.symbolSearchEnabled) ? (
                  <FindBar
                    className="scholar-reader-toolbar"
                    /*
                     * Set the key for the widget to the time that the find event was activated
                     * (i.e., when 'Ctrl+F' was typed). This regenerates the widgets whenever
                     * a new 'find' action is started, which will select and focus the text
                     * in the search widget. See why we use key to regenerate component here:
                     * https://reactjs.org/blog/2018/06/07/you-probably-dont-need-derived-state.html#recommendation-fully-uncontrolled-component-with-a-key
                     */
                    key={this.state.findActivationTimeMs}
                    matchCount={this.state.findMatchCount}
                    matchIndex={this.state.findMatchIndex}
                    mode={this.state.findMode}
                    pdfViewerApplication={this.state.pdfViewerApplication}
                    query={this.state.findQuery}
                    handleChangeMatchCount={this.setFindMatchCount}
                    handleChangeMatchIndex={this.setFindMatchIndex}
                    handleChangeQuery={this.setFindQuery}
                    handleClose={this.closeFindBar}
                  />
                ) : null}
                {this.state.entityCreationEnabled &&
                this.state.pages !== null ? (
                  <EntityCreationToolbar
                    className="scholar-reader-toolbar"
                    pages={this.state.pages}
                    entities={this.state.entities}
                    selectedEntityIds={this.state.selectedEntityIds}
                    entityType={this.state.entityCreationType}
                    selectionMethod={
                      this.state.entityCreationAreaSelectionMethod
                    }
                    handleShowSnackbarMessage={this.showSnackbarMessage}
                    handleSelectEntityType={this.setEntityCreationType}
                    handleSelectSelectionMethod={
                      this.setEntityCreationAreaSelectionMethod
                    }
                    handleCreateEntity={this.createEntity}
                    handleCreateParentSymbol={this.createParentSymbol}
                  />
                ) : null}
                {this.props.children}
              </div>
              {this.state.textSelectionMenuEnabled &&
              this.state.pages !== null ? (
                <TextSelectionMenu
                  key={this.state.textSelectionChangeMs || undefined}
                  pages={this.state.pages}
                  textSelection={this.state.textSelection}
                  handleShowSnackbarMessage={this.showSnackbarMessage}
                />
              ) : null}
              <Drawer
                pdfViewer={this.state.pdfViewer}
                mode={
                  this.state.drawerMode === "open" ||
                  this.state.entityEditingEnabled
                    ? "open"
                    : "closed"
                }
                contentType={
                  this.state.entityEditingEnabled
                    ? "entity-property-editor"
                    : this.state.drawerContentType
                }
                entities={this.state.entities}
                selectedEntityIds={this.state.selectedEntityIds}
                allFacetedHighlights={Object.values(
                  this.state.allHighlightsById
                )}
                facetedHighlights={facetedHighlights}
                selectedFacets={this.state.selectedFacets}
                highlightQuantity={this.state.highlightQuantity}
                showSkimmingAnnotationColors={
                  this.state.showSkimmingAnnotationColors
                }
                handleFacetSelected={this.selectFacet}
                handleJumpToHighlight={this.jumpToHighlight}
                propagateEntityEdits={this.state.propagateEntityEdits}
                handleJumpToEntity={this.jumpToEntityWithBackMessage}
                handleClose={this.closeDrawer}
                handleUpdateEntity={this.updateEntity}
                handleDeleteEntity={this.deleteEntity}
                handleSetPropagateEntityEdits={this.setPropagateEntityEdits}
                handleHighlightQuantityChanged={
                  this.handleHighlightQuantityChanged
                }
                handleSkimmingAnnotationColorsChanged={
                  this.handleSkimmingAnnotationColorsChanged
                }
              />
              {this.state.showSkimmingAnnotations &&
                this.state.facetDrawerEnabled && (
                  <DrawerControlFab
                    drawerOpen={this.state.drawerMode === "open"}
                    handleOpenDrawer={this.openDrawerWithFacets}
                    handleCloseDrawer={this.closeDrawer}
                  />
                )}
              {this.state.definitionPreviewEnabled &&
              this.state.pages !== null &&
              this.state.pdfDocument !== null &&
              this.state.entities !== null ? (
                <DefinitionPreview
                  pdfViewer={this.state.pdfViewer}
                  pdfDocument={this.state.pdfDocument}
                  pages={this.state.pages}
                  entities={this.state.entities}
                  selectedEntityIds={this.state.selectedEntityIds}
                />
              ) : null}
              {this.state.pdfViewerApplication &&
                this.state.pages !== null &&
                this.state.showSkimmingAnnotations &&
                this.state.facetedHighlights &&
                facetedHighlights.length > 0 && (
                  <ScrollbarMarkup
                    numPages={
                      this.state.pdfViewerApplication?.pdfDocument?.numPages
                    }
                    facetedHighlights={facetedHighlights}
                    captionUnits={[]}
                    handleMarkClicked={this.onScrollbarMarkClicked}
                  ></ScrollbarMarkup>
                )}
            </ViewerOverlay>
          </>
        ) : null}
        {this.state.primerPageEnabled &&
        this.state.pdfViewer !== null &&
        this.state.pages !== null ? (
          <PrimerPage
            paperId={this.props.paperId}
            pdfViewer={this.state.pdfViewer}
            pages={this.state.pages}
            entities={this.state.entities}
            annotationHintsEnabled={this.state.annotationHintsEnabled}
            primerPageGlossaryEnabled={this.state.primerPageGlossaryEnabled}
            termGlossesEnabled={this.state.termGlossesEnabled}
            showInstructions={this.state.primerInstructionsEnabled}
            scrollToPageOnLoad={this.state.initialFocus === null}
            handleSetAnnotationHintsEnabled={this.setAnnotationHintsEnabled}
            areCitationsLoading={this.state.areCitationsLoading}
          />
        ) : null}
        {
          /* Add overlays (e.g., annotations, etc.) atop each page. */
          this.state.pages !== null &&
          (this.state.entities !== null ||
            (this.props.paperId !== undefined &&
              this.props.paperId.type === "custom")) ? (
            <>
              {Object.keys(this.state.pages).map((pageNumberKey) => {
                const pages = this.state.pages as Pages;
                const entities = this.state.entities as Entities;

                const pageNumber = Number(pageNumberKey);
                const pageModel = pages[pageNumber];
                const pageView = pageModel.view;

                /*
                 * By setting the key to the page number *and* the timestamp it was rendered, React will
                 * know to replace a page overlay when a pdf.js re-renders a page.
                 */
                const key = `${pageNumber}-${pageModel.timeOfLastRender}`;

                /*
                 * Prevent unnecessary renders by only passing in the subset of selected entity and
                 * annotation IDs for this page. The PageOverlay performs a deep comparison of the
                 * lists of IDs to determine whether to re-render.
                 */
                const selectedEntityIds = selectors.entityIdsInPage(
                  this.state.selectedEntityIds,
                  this.state.entities,
                  pageNumber
                );
                const selectedAnnotationIds = selectors.annotationsInPage(
                  this.state.selectedAnnotationIds,
                  pageNumber
                );
                const selectedAnnotationSpanIds = selectors.annotationSpansInPage(
                  this.state.selectedAnnotationSpanIds,
                  pageNumber
                );
                const findFirstMatchEntityId =
                  this.state.symbolSearchEnabled &&
                  this.state.findMatchedEntities !== null &&
                  this.state.findMatchedEntities.length > 0 &&
                  selectors.entityIdsInPage(
                    [this.state.findMatchedEntities[0]],
                    entities,
                    pageNumber
                  ).length > 0
                    ? this.state.findMatchedEntities[0]
                    : null;
                const findMatchedEntityIds =
                  this.state.symbolSearchEnabled &&
                  this.state.isFindActive &&
                  this.state.findMatchedEntities !== null
                    ? selectors.entityIdsInPage(
                        this.state.findMatchedEntities,
                        entities,
                        pageNumber
                      )
                    : null;
                const findSelectionEntityId =
                  selectors.entityIdsInPage(
                    findMatchEntityId ? [findMatchEntityId] : [],
                    entities,
                    pageNumber
                  )[0] || null;
                const jumpTarget =
                  selectors.entityIdsInPage(
                    this.state.jumpTarget ? [this.state.jumpTarget] : [],
                    entities,
                    pageNumber
                  )[0] || null;

                return (
                  <PageOverlay key={key} pageView={pageView}>
                    {/* Mask for highlighting results from in-situ search. */}
                    {!this.state.entityCreationEnabled &&
                    this.state.declutterEnabled &&
                    (this.state.findMode === "symbol" ||
                      this.state.findMode === "term") &&
                    findMatchedEntityIds !== null ? (
                      <SearchPageMask
                        pageView={pageView}
                        entities={entities}
                        firstMatchingEntityId={findFirstMatchEntityId}
                        matchingEntityIds={findMatchedEntityIds}
                        highlightFirstMatch={false}
                      />
                    ) : null}
                    {/* Mask for highlighting selected entities. */}
                    {!this.state.entityCreationEnabled &&
                    this.state.equationDiagramsEnabled &&
                    selectedEntityIds
                      .map((id) => entities.byId[id])
                      .filter((e) => e !== undefined)
                      .some(isEquation) ? (
                      <EntityPageMask
                        pageView={pageView}
                        entities={entities}
                        selectedEntityIds={selectedEntityIds}
                      />
                    ) : null}
                    {/* Interactive annotations on entities. */}
                    {this.state.entities !== null && (
                      <EntityAnnotationLayer
                        paperId={this.props.paperId}
                        pageView={pageView}
                        entities={entities}
                        lazyPapers={this.state.lazyPapers}
                        cachePaper={this.cachePaper}
                        selectedEntityIds={selectedEntityIds}
                        selectedAnnotationIds={selectedAnnotationIds}
                        selectedAnnotationSpanIds={selectedAnnotationSpanIds}
                        findMatchedEntityIds={findMatchedEntityIds}
                        findSelectionEntityId={findSelectionEntityId}
                        jumpTarget={jumpTarget}
                        showAnnotations={this.state.annotationHintsEnabled}
                        annotationInteractionEnabled={
                          this.state.annotationInteractionEnabled
                        }
                        showGlosses={this.state.glossesEnabled}
                        citationAnnotationsEnabled={
                          this.state.citationGlossesEnabled
                        }
                        termAnnotationsEnabled={this.state.termGlossesEnabled}
                        symbolUnderlineMethod={this.state.symbolUnderlineMethod}
                        definitionsInSymbolGloss={
                          this.state.definitionsInSymbolGloss
                        }
                        glossStyle={this.state.glossStyle}
                        glossEvaluationEnabled={
                          this.state.glossEvaluationEnabled
                        }
                        equationDiagramsEnabled={
                          this.state.equationDiagramsEnabled
                        }
                        copySentenceOnClick={
                          this.state.sentenceTexCopyOnOptionClickEnabled
                        }
                        handleSelectEntityAnnotation={
                          this.selectEntityAnnotation
                        }
                        handleShowSnackbarMessage={this.showSnackbarMessage}
                        handleJumpToEntity={this.jumpToEntityWithBackMessage}
                        handleOpenDrawer={this.openDrawer}
                      />
                    )}
                    {/* Equation diagram overlays. */}
                    {this.state.equationDiagramsEnabled &&
                      selectedEntityIds
                        .map((id) => entities.byId[id])
                        .filter((e) => e !== undefined)
                        .filter(isEquation)
                        .map((e) => (
                          <EquationDiagram
                            key={`${e.id}-${this.state.useDefinitionsForDiagramLabels}`}
                            pageView={pageView}
                            entities={entities}
                            equation={e}
                            labelSource={
                              this.state.useDefinitionsForDiagramLabels
                                ? "any-definition"
                                : "only-diagram-labels"
                            }
                            handleShowMore={this.selectEntity}
                          />
                        ))}
                    {/* Canvas for annotating entities. */}
                    {this.state.entityCreationEnabled &&
                      this.state.entityCreationAreaSelectionMethod ===
                        "rectangular-selection" && (
                        <EntityCreationCanvas
                          pageView={pageView}
                          pageNumber={pageNumber}
                          entityType={this.state.entityCreationType}
                          handleShowSnackbarMessage={this.showSnackbarMessage}
                          handleCreateEntity={this.createEntity}
                        />
                      )}

                    {this.props.paperId !== undefined &&
                      this.state.showSkimmingAnnotations &&
                      this.state.facetTextEnabled &&
                      facetedHighlights.length > 0 && (
                        <FacetLabelLayer
                          pageView={pageView}
                          facetedHighlights={facetedHighlights}
                        ></FacetLabelLayer>
                      )}

                    {this.props.paperId !== undefined &&
                      this.state.showSkimmingAnnotations &&
                      facetedHighlights.length > 0 &&
                      this.state.cueingStyle === "highlight" && (
                        <>
                          <MarkerLayer
                            pageView={pageView}
                            sections={this.state.sections.filter(
                              (s) => s.section in this.state.highlightsBySection
                            )}
                            handleMarkerClicked={
                              this.showAllHighlightsForSection
                            }
                          ></MarkerLayer>
                          <HighlightLayer
                            pageView={pageView}
                            facetedHighlights={facetedHighlights}
                            opacity={this.state.skimOpacity}
                            handleHighlightSelected={this.setCurrentHighlightId}
                            handleHideHighlight={this.hideHighlight}
                            handleOpenDrawer={this.openDrawerWithFacets}
                            handleCloseDrawer={this.closeDrawer}
                            drawerOpen={this.state.drawerMode === "open"}
                            handleFilterToFacet={this.filterToFacet}
                            selectSnippetInDrawer={this.selectSnippetInDrawer}
                          ></HighlightLayer>
                        </>
                      )}

                    {this.props.paperId !== undefined &&
                      this.state.showSkimmingAnnotations &&
                      facetedHighlights.length > 0 &&
                      this.state.cueingStyle === "underline" && (
                        <UnderlineLayer
                          pageView={pageView}
                          facetedHighlights={facetedHighlights}
                        ></UnderlineLayer>
                      )}
                  </PageOverlay>
                );
              })}
            </>
          ) : null
        }
      </>
    );
  }

  private _backButtonHintShown: boolean = false;
  private _jumpedToInitialFocus: boolean = false;
}

async function waitForPDFViewerInitialization() {
  return new Promise<PDFViewerApplication>((resolve) => {
    const CHECK_CYCLE_MS = 50;
    function check() {
      if (
        window.PDFViewerApplication !== undefined &&
        window.PDFViewerApplication.initialized
      ) {
        resolve(window.PDFViewerApplication);
      } else {
        setTimeout(check, CHECK_CYCLE_MS);
      }
    }
    check();
  });
}
