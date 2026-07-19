import { describe, expect, it } from "vitest";
import {
  TRACKS,
  WEDGE_NOTES,
  allLessons,
  getLesson,
  getTrackForLesson,
  nextLesson,
} from "@/lib/education";
import { WEDGE_IDS } from "@/lib/flavor-wheel";

describe("curriculum integrity", () => {
  it("has unique lesson slugs across all tracks", () => {
    const slugs = allLessons().map((l) => l.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.length).toBeGreaterThanOrEqual(8);
  });

  it("every lesson has content, key terms, and a 3+ question quiz", () => {
    for (const lesson of allLessons()) {
      expect(lesson.title.length, lesson.slug).toBeGreaterThan(0);
      expect(lesson.teaser.length, lesson.slug).toBeGreaterThan(0);
      expect(lesson.minutes, lesson.slug).toBeGreaterThanOrEqual(2);
      expect(lesson.minutes, lesson.slug).toBeLessThanOrEqual(3);
      expect(lesson.sections.length, lesson.slug).toBeGreaterThanOrEqual(3);
      for (const section of lesson.sections) {
        expect(section.heading.length, lesson.slug).toBeGreaterThan(0);
        expect(section.paragraphs.length + (section.bullets?.length ?? 0), lesson.slug).toBeGreaterThan(0);
      }
      expect(lesson.keyTerms.length, lesson.slug).toBeGreaterThanOrEqual(3);
      expect(lesson.quiz.length, lesson.slug).toBeGreaterThanOrEqual(3);
    }
  });

  it("every quiz answer index points at a real option and has an explanation", () => {
    for (const lesson of allLessons()) {
      for (const q of lesson.quiz) {
        expect(q.options.length, `${lesson.slug}: ${q.prompt}`).toBeGreaterThanOrEqual(3);
        expect(q.answerIndex, `${lesson.slug}: ${q.prompt}`).toBeGreaterThanOrEqual(0);
        expect(q.answerIndex, `${lesson.slug}: ${q.prompt}`).toBeLessThan(q.options.length);
        expect(q.explanation.length, `${lesson.slug}: ${q.prompt}`).toBeGreaterThan(0);
      }
    }
  });

  it("relatedWedgeIds only reference wedges in the shared taxonomy", () => {
    for (const lesson of allLessons()) {
      for (const id of lesson.relatedWedgeIds ?? []) {
        expect(WEDGE_IDS, `${lesson.slug} references unknown wedge "${id}"`).toContain(id);
      }
    }
  });
});

describe("wedge notes", () => {
  it("covers every wedge in the flavor wheel, and nothing else", () => {
    expect(Object.keys(WEDGE_NOTES).sort()).toEqual([...WEDGE_IDS].sort());
  });

  it("every note has source, blurb, and spot-it copy", () => {
    for (const [id, note] of Object.entries(WEDGE_NOTES)) {
      expect(note.source.length, id).toBeGreaterThan(0);
      expect(note.blurb.length, id).toBeGreaterThan(0);
      expect(note.spotIt.length, id).toBeGreaterThan(0);
    }
  });
});

describe("lookups", () => {
  it("getLesson and getTrackForLesson resolve every slug", () => {
    for (const track of TRACKS) {
      for (const lesson of track.lessons) {
        expect(getLesson(lesson.slug)).toBe(lesson);
        expect(getTrackForLesson(lesson.slug)).toBe(track);
      }
    }
    expect(getLesson("not-a-lesson")).toBeUndefined();
    expect(getTrackForLesson("not-a-lesson")).toBeUndefined();
  });

  it("nextLesson walks the whole curriculum in order and ends", () => {
    const lessons = allLessons();
    for (let i = 0; i < lessons.length - 1; i++) {
      expect(nextLesson(lessons[i].slug)).toBe(lessons[i + 1]);
    }
    expect(nextLesson(lessons[lessons.length - 1].slug)).toBeUndefined();
    expect(nextLesson("not-a-lesson")).toBeUndefined();
  });
});
