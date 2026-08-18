"use client";
import * as React from "react";
import { Rnd } from "react-rnd";
import { RotateCw } from "lucide-react";
import type {
  BuiltInElementId,
  Device,
  ElementId,
  ElementTransform,
  Orientation,
  SelectedElement,
  Slide,
  TextElement,
  Theme,
} from "@/lib/types";
import {
  CANVAS,
  CARPLAY_RATIO,
  IPAD_RATIO,
  MK_RATIO,
  TV_RATIO,
  WATCH_RATIO,
  desktopW,
  carPlayW,
