import type { WebContents } from "electron";

export type WordPressDraftEvidence = {
  verified: boolean;
  titleMatched: boolean;
  draftStatusHint: boolean;
  url: string;
  evidence: string;
};

/**
 * Fail-closed WordPress draft verification after create_post ORC.
 * Never invent success — requires DOM/URL evidence that the draft title is present.
 */
export async function verifyWordPressDraft(params: {
  webContents: WebContents;
  title: string;
}): Promise<WordPressDraftEvidence> {
  const expected = params.title.trim();
  if (!expected) {
    return {
      verified: false,
      titleMatched: false,
      draftStatusHint: false,
      url: "",
      evidence: "missing_expected_title",
    };
  }

  let url = "";
  try {
    url = params.webContents.getURL() || "";
  } catch {
    url = "";
  }

  let probe: {
    titleMatched: boolean;
    draftStatusHint: boolean;
    bodySnippet: string;
  };
  try {
    probe = (await params.webContents.executeJavaScript(
      `(() => {
        const expected = ${JSON.stringify(expected)};
        const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const want = norm(expected);
        const titleEl =
          document.querySelector('#title') ||
          document.querySelector('input[name="post_title"]') ||
          document.querySelector('.editor-post-title__input') ||
          document.querySelector('h1.editor-post-title');
        const titleVal = titleEl
          ? (titleEl.value != null ? String(titleEl.value) : String(titleEl.textContent || ''))
          : '';
        const bodyText = (document.body && document.body.innerText) || '';
        const titleMatched =
          (want.length > 0 && norm(titleVal).includes(want)) ||
          (want.length > 0 && norm(bodyText).includes(want));
        const statusText = norm(
          (document.querySelector('#post-status-display') &&
            document.querySelector('#post-status-display').textContent) ||
            (document.querySelector('.editor-post-saved-state') &&
              document.querySelector('.editor-post-saved-state').textContent) ||
            ''
        );
        const draftStatusHint =
          statusText.includes('draft') ||
          statusText.includes('nháp') ||
          /post-new\\.php|post\\.php\\?.*action=edit|edit\\.php/.test(location.href) ||
          !!document.querySelector('#save-post') ||
          !!document.querySelector('.editor-post-save-draft');
        return {
          titleMatched,
          draftStatusHint,
          bodySnippet: bodyText.replace(/\\s+/g, ' ').trim().slice(0, 160),
        };
      })()`,
      true
    )) as {
      titleMatched: boolean;
      draftStatusHint: boolean;
      bodySnippet: string;
    };
  } catch (err) {
    return {
      verified: false,
      titleMatched: false,
      draftStatusHint: false,
      url,
      evidence: `dom_probe_failed:${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const verified = Boolean(probe.titleMatched && probe.draftStatusHint);
  return {
    verified,
    titleMatched: Boolean(probe.titleMatched),
    draftStatusHint: Boolean(probe.draftStatusHint),
    url,
    evidence: verified
      ? "title_and_draft_ui"
      : `unverified titleMatched=${probe.titleMatched} draftHint=${probe.draftStatusHint}`,
  };
}
