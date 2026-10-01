"use client";

import { ChevronDown, Download, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ExportContent } from "@/lib/export-plan";

export function ExportBundleButton({ onExport }: { onExport(content: ExportContent): void }) {
  return (
    <div className="inline-flex" role="group" aria-label="Export bundle">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            className="h-8 rounded-r-none border-r border-primary-foreground/20 px-2"
            aria-label="Export options"
            title="Export options"
          >
            <ChevronDown className="h-4 w-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" collisionPadding={16} className="w-72">
          <DropdownMenuItem onSelect={() => onExport("screens")} className="items-start gap-2 py-2">
            <Download className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              <span className="block font-medium">Full screenshots</span>
              <span className="block text-xs text-muted-foreground">Complete store screens, all export sizes</span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onExport("device-frames")} className="items-start gap-2 py-2">
            <Smartphone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              <span className="block font-medium">Device frames only</span>
              <span className="block text-xs text-muted-foreground">Screenshots in frames · transparent PNGs</span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        type="button"
        onClick={() => onExport("screens")}
        size="sm"
        className="h-8 rounded-l-none"
        title="Export current, selected, or all project versions as a deterministic zip"
      >
        <Download className="h-4 w-4" aria-hidden />
        Export bundle
      </Button>
    </div>
  );
}
