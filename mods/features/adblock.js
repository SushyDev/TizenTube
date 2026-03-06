import { configRead } from '../config.js';
import Chapters from '../ui/chapters.js';
import resolveCommand from '../resolveCommand.js';
import { timelyAction, longPressData, MenuServiceItemRenderer, ShelfRenderer, TileRenderer, ButtonRenderer } from '../ui/ytUI.js';
import { PatchSettings } from '../ui/customYTSettings.js';

/**
 * Central JSON.parse intercept.
 *
 * YouTube TV processes all server responses through JSON.parse, so patching it
 * is the standard approach for modifying response data without touching the
 * app's bundled code.
 *
 * Ad-blocking technique adapted from the following uBlock Origin rule:
 * https://github.com/uBlockOrigin/uAssets/blob/3497eebd440f4871830b9b45af0afc406c6eb593/filters/filters.txt#L116
 */
const origParse = JSON.parse;
JSON.parse = function () {
  const r = origParse.apply(this, arguments);

  // ── Ad blocking ──────────────────────────────────────────────────────────
  const adBlockEnabled = configRead('enableAdBlock');

  if (r.adPlacements && adBlockEnabled) {
    r.adPlacements = [];
  }

  if (r.playerAds && adBlockEnabled) {
    r.playerAds = false;
  }

  if (r.adSlots && adBlockEnabled) {
    r.adSlots = [];
  }

  if (r.paidContentOverlay && !configRead('enablePaidPromotionOverlay')) {
    r.paidContentOverlay = null;
  }

  // ── Codec filtering ───────────────────────────────────────────────────────
  if (r && r.streamingData && r.streamingData.adaptiveFormats && configRead('videoPreferredCodec') !== 'any') {
    const preferredCodec = configRead('videoPreferredCodec');
    const hasPreferredCodec = r.streamingData.adaptiveFormats.find(format => format.mimeType.includes(preferredCodec));
    if (hasPreferredCodec) {
      r.streamingData.adaptiveFormats = r.streamingData.adaptiveFormats.filter(format => {
        if (format.mimeType.startsWith('audio/')) return true;
        return format.mimeType.includes(preferredCodec);
      });
    }
  }

  // ── Browse page processing (home/subscriptions/etc.) ─────────────────────
  const signinReminderEnabled = configRead('enableSigninReminder');
  const browseContents = r && r.contents && r.contents.tvBrowseRenderer &&
    r.contents.tvBrowseRenderer.content &&
    r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer &&
    r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content &&
    r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer &&
    r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents;

  if (browseContents) {
    const sectionListContents = r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents;

    if (!signinReminderEnabled) {
      r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents =
        sectionListContents.filter((elm) => !elm.feedNudgeRenderer);
    }

    if (adBlockEnabled) {
      r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents =
        r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents.filter(
          (elm) => !elm.adSlotRenderer
        );

      for (const shelve of r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents) {
        if (shelve.shelfRenderer) {
          shelve.shelfRenderer.content.horizontalListRenderer.items =
            shelve.shelfRenderer.content.horizontalListRenderer.items.filter(
              (item) => !item.adSlotRenderer
            );
        }
      }
    }

    processShelves(r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents);
  }

  if (r.endscreen && configRead('enableHideEndScreenCards')) {
    r.endscreen = null;
  }

  if (r.messages && Array.isArray(r.messages) && !configRead('enableYouThereRenderer')) {
    r.messages = r.messages.filter((msg) => !(msg && msg.youThereRenderer));
  }

  // Remove shorts ads
  if (!Array.isArray(r) && r && r.entries && adBlockEnabled) {
    r.entries = r.entries.filter(
      (elm) => !(elm && elm.command && elm.command.reelWatchEndpoint && elm.command.reelWatchEndpoint.adClientParams && elm.command.reelWatchEndpoint.adClientParams.isAd)
    );
  }

  // ── Settings page injection ───────────────────────────────────────────────
  if (r && r.title && r.title.runs) {
    PatchSettings(r);
  }

  // ── Shelf/tile processing (DeArrow, HQ thumbnails, long press, previews) ─
  if (r && r.contents && r.contents.sectionListRenderer && r.contents.sectionListRenderer.contents) {
    processShelves(r.contents.sectionListRenderer.contents);
  }

  if (r && r.continuationContents && r.continuationContents.sectionListContinuation && r.continuationContents.sectionListContinuation.contents) {
    processShelves(r.continuationContents.sectionListContinuation.contents);
  }

  if (r && r.continuationContents && r.continuationContents.horizontalListContinuation && r.continuationContents.horizontalListContinuation.items) {
    deArrowify(r.continuationContents.horizontalListContinuation.items);
    hqify(r.continuationContents.horizontalListContinuation.items);
    addLongPress(r.continuationContents.horizontalListContinuation.items);
    r.continuationContents.horizontalListContinuation.items = hideVideo(r.continuationContents.horizontalListContinuation.items);
  }

  if (r && r.contents && r.contents.tvBrowseRenderer && r.contents.tvBrowseRenderer.content && r.contents.tvBrowseRenderer.content.tvSecondaryNavRenderer && r.contents.tvBrowseRenderer.content.tvSecondaryNavRenderer.sections) {
    for (const section of r.contents.tvBrowseRenderer.content.tvSecondaryNavRenderer.sections) {
      for (const tab of section.tvSecondaryNavSectionRenderer.tabs) {
        processShelves(tab.tabRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents);
      }
    }
  }

  // ── Watch-next page processing (queue, sign-in reminder) ─────────────────
  if (r && r.contents && r.contents.singleColumnWatchNextResults && r.contents.singleColumnWatchNextResults.pivot && r.contents.singleColumnWatchNextResults.pivot.sectionListRenderer) {
    if (!signinReminderEnabled) {
      r.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents =
        r.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents.filter(
          (elm) => !elm.alertWithActionsRenderer
        );
    }
    processShelves(r.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents, false);
    if (window.queuedVideos && window.queuedVideos.videos.length > 0) {
      const queuedVideosClone = window.queuedVideos.videos.slice();
      queuedVideosClone.unshift(TileRenderer(
        'Clear Queue',
        {
          customAction: {
            action: 'CLEAR_QUEUE'
          }
        }));
      const lastVideoIdx = queuedVideosClone.findIndex(v => v.tileRenderer && v.tileRenderer.contentId === window.queuedVideos.lastVideoId);
      r.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents.unshift(ShelfRenderer(
        'Queued Videos',
        queuedVideosClone,
        lastVideoIdx !== -1 ? lastVideoIdx : 0
      ));
    }
  }

  // ── SponsorBlock: manual skip buttons in player overlay ───────────────────
  const manualSkips = configRead('sponsorBlockManualSkips');
  if (manualSkips.length > 0 && r && r.playerOverlays && r.playerOverlays.playerOverlayRenderer) {
    const timelyActions = [];
    if (window.sponsorblock && window.sponsorblock.segments) {
      for (const segment of window.sponsorblock.segments) {
        if (manualSkips.includes(segment.category)) {
          timelyActions.push(timelyAction(
            `Skip ${segment.category}`,
            'SKIP_NEXT',
            {
              clickTrackingParams: null,
              showEngagementPanelEndpoint: {
                customAction: {
                  action: 'SKIP',
                  parameters: {
                    time: segment.segment[1]
                  }
                }
              }
            },
            segment.segment[0] * 1000,
            segment.segment[1] * 1000 - segment.segment[0] * 1000
          ));
        }
      }
      r.playerOverlays.playerOverlayRenderer.timelyActionRenderers = timelyActions;
    }
  } else if (r && r.playerOverlays && r.playerOverlays.playerOverlayRenderer) {
    r.playerOverlays.playerOverlayRenderer.timelyActionRenderers = [];
  }

  // ── SponsorBlock: highlight button in transport controls ──────────────────
  if (r && r.transportControls && r.transportControls.transportControlsRenderer && r.transportControls.transportControlsRenderer.promotedActions && configRead('enableSponsorBlockHighlight')) {
    if (window.sponsorblock && window.sponsorblock.segments) {
      const category = window.sponsorblock.segments.find(seg => seg.category === 'poi_highlight');
      if (category) {
        r.transportControls.transportControlsRenderer.promotedActions.push({
          type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPONSORBLOCK_HIGHLIGHT',
          button: {
            buttonRenderer: ButtonRenderer(
              false,
              'Skip to highlight',
              'SKIP_NEXT',
              {
                clickTrackingParams: null,
                customAction: {
                  action: 'SKIP',
                  parameters: {
                    time: category.segment[0]
                  }
                }
              })
          }
        });
      }
    }
  }

  return r;
};

// Patch JSON.parse to use the custom one
window.JSON.parse = JSON.parse;
for (const key in window._yttv) {
  if (window._yttv[key] && window._yttv[key].JSON && window._yttv[key].JSON.parse) {
    window._yttv[key].JSON.parse = JSON.parse;
  }
}


function processShelves(shelves, shouldAddPreviews = true) {
  for (const shelve of shelves) {
    if (shelve.shelfRenderer) {
      deArrowify(shelve.shelfRenderer.content.horizontalListRenderer.items);
      hqify(shelve.shelfRenderer.content.horizontalListRenderer.items);
      addLongPress(shelve.shelfRenderer.content.horizontalListRenderer.items);
      if (shouldAddPreviews) {
        addPreviews(shelve.shelfRenderer.content.horizontalListRenderer.items);
      }
      shelve.shelfRenderer.content.horizontalListRenderer.items = hideVideo(shelve.shelfRenderer.content.horizontalListRenderer.items);
      if (!configRead('enableShorts')) {
        if (shelve.shelfRenderer.tvhtml5ShelfRendererType === 'TVHTML5_SHELF_RENDERER_TYPE_SHORTS') {
          shelves.splice(shelves.indexOf(shelve), 1);
          continue;
        }
        shelve.shelfRenderer.content.horizontalListRenderer.items = shelve.shelfRenderer.content.horizontalListRenderer.items.filter(item => item.tileRenderer?.tvhtml5ShelfRendererType !== 'TVHTML5_TILE_RENDERER_TYPE_SHORTS');
      }
    }
  }
}

function addPreviews(items) {
  if (!configRead('enablePreviews')) return;
  for (const item of items) {
    if (item.tileRenderer) {
      const watchEndpoint = item.tileRenderer.onSelectCommand;
      if (item.tileRenderer?.onFocusCommand?.playbackEndpoint) continue;
      item.tileRenderer.onFocusCommand = {
        startInlinePlaybackCommand: {
          blockAdoption: true,
          caption: false,
          delayMs: 3000,
          durationMs: 40000,
          muted: false,
          restartPlaybackBeforeSeconds: 10,
          resumeVideo: true,
          playbackEndpoint: watchEndpoint
        }
      };
    }
  }
}

function deArrowify(items) {
  for (const item of items) {
    if (item.adSlotRenderer) {
      const index = items.indexOf(item);
      items.splice(index, 1);
      continue;
    }
    if (!item.tileRenderer) continue;
    if (configRead('enableDeArrow')) {
      const videoID = item.tileRenderer.contentId;
      fetch(`https://sponsor.ajay.app/api/branding?videoID=${videoID}`).then(res => res.json()).then(data => {
        if (data.titles.length > 0) {
          const mostVoted = data.titles.reduce((max, title) => max.votes > title.votes ? max : title);
          item.tileRenderer.metadata.tileMetadataRenderer.title.simpleText = mostVoted.title;
        }

        if (data.thumbnails.length > 0 && configRead('enableDeArrowThumbnails')) {
          const mostVotedThumbnail = data.thumbnails.reduce((max, thumbnail) => max.votes > thumbnail.votes ? max : thumbnail);
          if (mostVotedThumbnail.timestamp) {
            item.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails = [
              {
                url: `https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=${videoID}&time=${mostVotedThumbnail.timestamp}`,
                width: 1280,
                height: 640
              }
            ]
          }
        }
      }).catch(() => { });
    }
  }
}


function hqify(items) {
  for (const item of items) {
    if (!item.tileRenderer) continue;
    if (item.tileRenderer.style !== 'TILE_STYLE_YTLR_DEFAULT') continue;
    if (configRead('enableHqThumbnails')) {
      const videoID = item.tileRenderer.onSelectCommand.watchEndpoint.videoId;
      const queryArgs = item.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails[0].url.split('?')[1];
      item.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails = [
        {
          url: `https://i.ytimg.com/vi/${videoID}/sddefault.jpg${queryArgs ? `?${queryArgs}` : ''}`,
          width: 640,
          height: 480
        }
      ];
    }
  }
}

function addLongPress(items) {
  for (const item of items) {
    if (!item.tileRenderer) continue;
    if (item.tileRenderer.style !== 'TILE_STYLE_YTLR_DEFAULT') continue;
    if (item.tileRenderer.onLongPressCommand) {
      item.tileRenderer.onLongPressCommand.showMenuCommand.menu.menuRenderer.items.push(MenuServiceItemRenderer('Add to Queue', {
        clickTrackingParams: null,
        playlistEditEndpoint: {
          customAction: {
            action: 'ADD_TO_QUEUE',
            parameters: item
          }
        }
      }));
      continue;
    }
    if (!configRead('enableLongPress')) continue;
    const subtitle = item.tileRenderer.metadata.tileMetadataRenderer.lines[0].lineRenderer.items[0].lineItemRenderer.text;
    const data = longPressData({
      videoId: item.tileRenderer.contentId,
      thumbnails: item.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails,
      title: item.tileRenderer.metadata.tileMetadataRenderer.title.simpleText,
      subtitle: subtitle.runs ? subtitle.runs[0].text : subtitle.simpleText,
      watchEndpointData: item.tileRenderer.onSelectCommand.watchEndpoint,
      item
    });
    item.tileRenderer.onLongPressCommand = data;
  }
}

function hideVideo(items) {
  return items.filter(item => {
    if (!item.tileRenderer) return true;
    const progressBar = item.tileRenderer.header?.tileHeaderRenderer?.thumbnailOverlays?.find(overlay => overlay.thumbnailOverlayResumePlaybackRenderer)?.thumbnailOverlayResumePlaybackRenderer;
    if (!progressBar) return true;
    const pages = configRead('hideWatchedVideosPages');
    const hash = location.hash.substring(1);
    const pageName = hash === '/' ? 'home' : hash.startsWith('/search') ? 'search' : hash.split('?')[1].split('&')[0].split('=')[1].replace('FE', '').replace('topics_', '');
    if (!pages.includes(pageName)) return true;

    const percentWatched = (progressBar.percentDurationWatched || 0);
    return percentWatched <= configRead('hideWatchedVideosThreshold');
  });
}