import { describe, expect, it } from "vitest";
import { XML_MAX_DEPTH, XmlError, xmlDecode, xmlEncode } from "./xml.js";

/** S3's GetBucketCors answer, as the API reference shows it (plus a comment and an escaped origin). */
const CORS = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <!-- two rules -->
  <CORSRule>
    <ID>sponson-pr-42</ID>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedOrigin>https://pr-42.example.app?a=1&amp;b=2</AllowedOrigin>
    <MaxAgeSeconds>3000</MaxAgeSeconds>
  </CORSRule>
  <CORSRule><AllowedMethod>GET</AllowedMethod><AllowedOrigin>*</AllowedOrigin><ExposeHeader/></CORSRule>
</CORSConfiguration>`;

describe("xml codec", () => {
  it("decodes an S3 CORS configuration: repeated elements are lists, text is strings, attributes are @-keys", () => {
    expect(xmlDecode(CORS)).toEqual({
      CORSConfiguration: {
        "@xmlns": "http://s3.amazonaws.com/doc/2006-03-01/",
        CORSRule: [
          { ID: "sponson-pr-42", AllowedMethod: ["GET", "PUT"], AllowedOrigin: "https://pr-42.example.app?a=1&b=2", MaxAgeSeconds: "3000" },
          { AllowedMethod: "GET", AllowedOrigin: "*", ExposeHeader: "" },
        ],
      },
    });
  });

  it("encodes the inverse: lists repeat, null is left out, text is escaped, and decoding it gives the same document", () => {
    const body = { CORSConfiguration: { CORSRule: [{ ID: "a<b", AllowedMethod: ["GET", "HEAD"], AllowedOrigin: "https://x&y", MaxAgeSeconds: 600, Gone: null, On: true }] } };
    const xml = xmlEncode(body);
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration><CORSRule><ID>a&lt;b</ID><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedOrigin>https://x&amp;y</AllowedOrigin><MaxAgeSeconds>600</MaxAgeSeconds><On>true</On></CORSRule></CORSConfiguration>',
    );
    expect(xmlDecode(xmlEncode(xmlDecode(CORS)))).toEqual(xmlDecode(CORS));
    expect(xmlEncode({ Root: { "@xmlns": 'u"v', "#text": "t" } })).toContain('<Root xmlns="u&quot;v">t</Root>');
    expect(xmlDecode('<Root a="1">t</Root>')).toEqual({ Root: { "@a": "1", "#text": "t" } });
    expect(xmlDecode("<R><![CDATA[a<b]]>&#65;&#x42;&apos;</R>")).toEqual({ R: "a<bAB'" });
    expect(xmlDecode("<R/>")).toEqual({ R: "" });
  });

  it("refuses DTDs, entity declarations and unknown entities (no XXE, no expansion)", () => {
    expect(() => xmlDecode('<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>')).toThrow(XmlError);
    expect(() => xmlDecode("<r>&x;</r>")).toThrow(/unknown entity/);
  });

  it("refuses malformed documents and bodies it cannot express", () => {
    for (const bad of ["", "text", "<a>", "<a></b>", "<a/><b/>", "<1a/>", "<a><!-- x</a>", "<a><![CDATA[x</a>", "<a", "</a>"]) expect(() => xmlDecode(bad), bad).toThrow(XmlError);
    expect(() => xmlDecode(`${"<a>".repeat(XML_MAX_DEPTH + 1)}${"</a>".repeat(XML_MAX_DEPTH + 1)}`)).toThrow(/deeper/);
    expect(() => xmlEncode({ a: 1, b: 2 })).toThrow(/exactly one key/);
    expect(() => xmlEncode([1])).toThrow(/exactly one key/);
    expect(() => xmlEncode({ "bad name": "x" })).toThrow(/not an XML element name/);
    expect(() => xmlEncode({ r: { "@x y": "1" } })).toThrow(/not an XML element name/);
    expect(() => xmlEncode({ r: { "#text": { a: 1 } } })).toThrow(/must be a map, a list, a string/);
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i <= XML_MAX_DEPTH + 1; i++) cur = (cur.a = {}) as Record<string, unknown>;
    expect(() => xmlEncode({ r: deep })).toThrow(/deeper/);
  });
});
