import { describe, expect, test } from "bun:test";
import { eventFacetsFromWire } from "./App";

const projects = [{ value: "sample-oracle", count: 42 }];
const folders = [{ value: "/tmp/sample-oracle", label: "sample-oracle", count: 7 }];

describe("event facet response", () => {
  test("accepts the nested API response", () => {
    expect(eventFacetsFromWire({ facets: { projects, folders } })).toEqual({
      projects,
      folders,
    });
  });

  test("accepts the direct API response and defaults missing arrays", () => {
    expect(eventFacetsFromWire({ projects, folders })).toEqual({ projects, folders });
    expect(eventFacetsFromWire({ facets: { projects } })).toEqual({
      projects,
      folders: [],
    });
  });
});
