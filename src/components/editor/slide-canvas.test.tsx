import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { THEMES } from "../../lib/constants";
import type { Slide } from "../../lib/types";
import { DeckCanvas } from "./slide-canvas";

describe("DeckCanvas", () => {
  it("renders the persisted custom slide background color", () => {
    const slide: Slide = {
      id: "custom-background",
      layout: "no-device",
      label: { en: "" },
      headline: { en: "Custom" },
      screenshot: "",
      backgroundColor: "#123456",
    };

    const markup = renderToStaticMarkup(
      <DeckCanvas
        slides={[slide]}
        device="iphone"
        orientation="portrait"
        theme={THEMES["clean-light"]}
        locale="en"
        connectedCanvas={false}
      />,
    );

    expect(markup).toContain("#123456");
  });
});
