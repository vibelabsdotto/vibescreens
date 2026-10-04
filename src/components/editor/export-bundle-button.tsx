"use client";

import { ChevronDown, Download, Image as ImageIcon, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ExportContent } from "@/lib/export-plan";

export function ExportBundleButton({ onExport }: { onExport(content: ExportContent): void }) {
  return (
    <div className="inline-flex" role="group" aria-label="Export bundle">
      <Button
        type="button"
        onClick={() => onExport("screens")}
        size="sm"
        className="h-8 rounded-r-none"
        title="Export current, selected, or all project versions as a deterministic zip"
      >
        <Download data-icon="inline-start" aria-hidden />
        Export bundle
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            className="h-8 rounded-l-none border-l border-primary-foreground/20 px-2"
            aria-label="Export options"
            title="Export options"
          >
            <ChevronDown data-icon="inline-end" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" collisionPadding={16} className="w-72">
          <DropdownMenuGroup>
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
            <DropdownMenuItem onSelect={() => onExport("device-frames-with-assets")} className="items-start gap-2 py-2">
              <ImageIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                <span className="block font-medium">Device Frames with assets</span>
                <span className="block text-xs text-muted-foreground">Frames + image overlays · no text · transparent</span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
