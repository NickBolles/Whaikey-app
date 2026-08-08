// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NoteCapture, type ExtractedTastingNote } from "@/components/note-capture";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Reset the voice-capability globals between tests.
  delete (window as unknown as Record<string, unknown>).MediaRecorder;
  delete (window as unknown as Record<string, unknown>).SpeechRecognition;
  delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
});

const PAYLOAD: ExtractedTastingNote = {
  nose: "Bright citrus and honey",
  palate: "Honeyed oak, gentle spice",
  finish: "Long and warming",
  flavorTags: { citrus: 3, honey: 2 },
  suggestedRating: 4.5,
  servingStyle: "neat",
};

function mockFetchOnce(response: {
  ok: boolean;
  status: number;
  body?: unknown;
}) {
  const fn = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: async () => response.body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("NoteCapture", () => {
  it("renders the freeform textarea and reports typing", async () => {
    const onFreeformChange = vi.fn();
    render(
      <NoteCapture
        freeform=""
        onFreeformChange={onFreeformChange}
        onApplyExtraction={() => {}}
      />,
    );
    const textarea = screen.getByLabelText("Anything else");
    await userEvent.type(textarea, "x");
    expect(onFreeformChange).toHaveBeenCalledWith("x");
  });

  it("extracts, shows a confirmation card, and Apply passes the payload", async () => {
    const fetchMock = mockFetchOnce({ ok: true, status: 200, body: PAYLOAD });
    const onApply = vi.fn();
    render(
      <NoteCapture
        freeform="Lovely citrus and honey, long finish"
        onFreeformChange={() => {}}
        onApplyExtraction={onApply}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /auto-fill tasting fields/i }),
    );

    // Posted the freeform text to the extraction endpoint.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/extract-note",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "Lovely citrus and honey, long finish" }),
      }),
    );

    // Confirmation card: rating, flavor chips, and nose/palate/finish.
    expect(await screen.findByText("4.5★")).toBeInTheDocument();
    expect(screen.getByText("Citrus")).toBeInTheDocument();
    expect(screen.getByText("Honey")).toBeInTheDocument();
    expect(screen.getByText("Bright citrus and honey")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith(PAYLOAD);
  });

  it("Discard dismisses the card without applying", async () => {
    mockFetchOnce({ ok: true, status: 200, body: PAYLOAD });
    const onApply = vi.fn();
    render(
      <NoteCapture
        freeform="Some notes"
        onFreeformChange={() => {}}
        onApplyExtraction={onApply}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /auto-fill tasting fields/i }),
    );
    await screen.findByText("4.5★");

    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText("4.5★")).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("shows a friendly message on 503 and does not apply", async () => {
    mockFetchOnce({ ok: false, status: 503, body: { error: "not configured" } });
    const onApply = vi.fn();
    render(
      <NoteCapture
        freeform="Some notes"
        onFreeformChange={() => {}}
        onApplyExtraction={onApply}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /auto-fill tasting fields/i }),
    );

    expect(await screen.findByText(/auto-fill is off/i)).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
    // The extract button is hidden once AI is known to be off.
    expect(
      screen.queryByRole("button", { name: /auto-fill tasting fields/i }),
    ).not.toBeInTheDocument();
  });

  it("hides the mic button when no voice API is available", () => {
    render(
      <NoteCapture
        freeform=""
        onFreeformChange={() => {}}
        onApplyExtraction={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /dictate/i })).not.toBeInTheDocument();
  });

  it("shows the mic button when a voice API is available", () => {
    (window as unknown as Record<string, unknown>).MediaRecorder = class {};
    render(
      <NoteCapture
        freeform=""
        onFreeformChange={() => {}}
        onApplyExtraction={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /dictate/i })).toBeInTheDocument();
  });

  it("takes a custom label and placeholder for the primary-capture framing", () => {
    render(
      <NoteCapture
        freeform=""
        onFreeformChange={() => {}}
        onApplyExtraction={() => {}}
        label="Say what you taste"
      />,
    );
    expect(screen.getByLabelText("Say what you taste")).toBeInTheDocument();
  });
});

describe("NoteCapture local flavor pass", () => {
  it("shows flavors named in the note without calling the model", () => {
    const fetchMock = mockFetchOnce({ ok: true, status: 200, body: PAYLOAD });
    render(
      <NoteCapture
        freeform="loads of vanilla and oak"
        onFreeformChange={() => {}}
        onApplyExtraction={() => {}}
      />,
    );

    const heard = screen.getByLabelText("Flavors heard in your note");
    expect(heard).toHaveTextContent("Vanilla");
    expect(heard).toHaveTextContent("Oak");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies the heard flavors at a neutral intensity", async () => {
    const onApply = vi.fn();
    render(
      <NoteCapture
        freeform="loads of vanilla and oak"
        onFreeformChange={() => {}}
        onApplyExtraction={onApply}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /add these flavors/i }));
    expect(onApply).toHaveBeenCalledWith({
      nose: null,
      palate: null,
      finish: null,
      flavorTags: { vanilla: 2, oak: 2 },
      suggestedRating: null,
      servingStyle: null,
    });
  });

  it("works with AI switched off, so a slow or absent model never blocks tagging", async () => {
    const onApply = vi.fn();
    render(
      <NoteCapture
        freeform="smoky campfire notes"
        onFreeformChange={() => {}}
        onApplyExtraction={onApply}
        aiConfigured={false}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /auto-fill tasting fields/i }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /add this flavor/i }));
    expect(onApply.mock.calls[0][0].flavorTags).toEqual({ campfire: 2 });
  });

  it("stands down once the model's own suggestion is on screen", async () => {
    mockFetchOnce({ ok: true, status: 200, body: PAYLOAD });
    render(
      <NoteCapture
        freeform="lovely citrus and honey"
        onFreeformChange={() => {}}
        onApplyExtraction={() => {}}
      />,
    );

    expect(screen.getByLabelText("Flavors heard in your note")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /auto-fill tasting fields/i }));
    await screen.findByText("4.5★");
    expect(screen.queryByLabelText("Flavors heard in your note")).not.toBeInTheDocument();
  });

  it("shows nothing for a note that names no flavors", () => {
    render(
      <NoteCapture
        freeform="poured this after work"
        onFreeformChange={() => {}}
        onApplyExtraction={() => {}}
      />,
    );
    expect(screen.queryByLabelText("Flavors heard in your note")).not.toBeInTheDocument();
  });
});
