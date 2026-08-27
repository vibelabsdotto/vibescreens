"use client";
import * as React from "react";
import { AlertTriangle, Check, Cloud, Download, Redo2, RotateCcw, Undo2, UnfoldHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DEVICE_LABEL,
  SCREENSHOT_FONTS,
  supportsLandscape,
  THEMES,
} from "@/lib/constants";
import { detectPlatform } from "@/lib/defaults";
import type { Device, Orientation, Platform, ScreenshotFontId } from "@/lib/types";
import type { ImportedFont } from "@/lib/types";
import { FontImporter } from "./font-importer";
