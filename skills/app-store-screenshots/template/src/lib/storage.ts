"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SCREENSHOT_FONT_ID, PROJECT_SCHEMA_VERSION, SCREENSHOT_FONTS, STORAGE_KEY } from "./constants";
import { cleanHexColor } from "./clean-hex-color";
import { cleanImportedFont } from "./clean-imported-font";
import { DEFAULT_PROJECT } from "./defaults";
import { coerceLocalized } from "./locale";
import { cleanTypography } from "./typography";
import type { Device, ElementTransform, ImageElement, ProjectState, Slide, TextElement } from "./types";
