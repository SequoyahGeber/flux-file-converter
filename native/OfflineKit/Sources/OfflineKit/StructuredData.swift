import Foundation
import Yams

enum StructuredData {
    static func convert(_ input: URL, output: URL, target: String, control: JobControl) throws {
        let text = try LocalPolicy.readText(input), ext = input.pathExtension.lowercased()
        let object: Any
        if ext == "json" {
            object = try JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])
        } else if ext == "yaml" || ext == "yml" {
            try preflightYAML(text)
            guard let root = try Yams.compose(yaml: text) else { throw LocalError.invalid("Empty YAML file.") }
            var budget = 100_000
            try validate(root, depth: 0, budget: &budget, control: control)
            object = root.any
        } else {
            let rows = try parseCSV(text, separator: ext == "tsv" ? "\t" : ",", control: control)
            guard let header = rows.first, !header.isEmpty, header.allSatisfy({ !$0.isEmpty }), Set(header).count == header.count else { throw LocalError.invalid("CSV needs unique, nonempty column headers.") }
            object = try rows.dropFirst().map { row -> [String: String] in
                guard row.count == header.count else { throw LocalError.invalid("CSV row has a different number of cells from its header.") }
                return Dictionary(uniqueKeysWithValues: zip(header, row))
            }
        }
        try control.check()
        let json = try JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed, .sortedKeys, .prettyPrinted])
        guard json.count <= LocalPolicy.textLimit else { throw LocalError.invalid("Converted data exceeds 16 MB.") }
        if target == "json" { try json.write(to: output) }
        else if target == "yaml" {
            let result = try Yams.dump(object: object, sortKeys: true)
            guard result.utf8.count <= LocalPolicy.textLimit else { throw LocalError.invalid("Converted YAML exceeds 16 MB.") }
            try result.write(to: output, atomically: false, encoding: .utf8)
        } else {
            guard let records = object as? [[String: Any]] else { throw LocalError.invalid("CSV/TSV output requires an array of objects.") }
            let headers = Set(records.flatMap { $0.keys }).sorted()
            guard headers.count <= 1000, records.count <= 100_000 else { throw LocalError.invalid("Table exceeds 1,000 columns or 100,000 rows.") }
            let delimiter = target == "tsv" ? "\t" : ","
            var result = headers.map { quote($0, separator: delimiter) }.joined(separator: delimiter) + "\r\n"
            for record in records {
                try control.check()
                let row = try headers.map { key -> String in
                    guard let value = record[key], !(value is NSNull) else { return "" }
                    let cell: String
                    if let string = value as? String { cell = string }
                    else if let number = value as? NSNumber { cell = number.stringValue }
                    else { cell = String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self) }
                    return quote(cell, separator: delimiter)
                }
                result += row.joined(separator: delimiter) + "\r\n"
                if result.utf8.count > LocalPolicy.textLimit { throw LocalError.invalid("Converted table exceeds 16 MB.") }
            }
            try result.write(to: output, atomically: false, encoding: .utf8)
        }
    }
    static func validate(_ node: Node, depth: Int, budget: inout Int, control: JobControl) throws {
        try control.check(); budget -= 1
        guard depth < 64, budget > 0 else { throw LocalError.invalid("YAML nesting or node count exceeds the safety limit.") }
        guard node.anchor == nil else { throw LocalError.invalid("YAML anchors and aliases are disabled to prevent expansion attacks.") }
        switch node {
        case .alias: throw LocalError.invalid("YAML aliases are disabled to prevent expansion attacks.")
        case .scalar: break
        case .sequence(let values): for value in values { try validate(value, depth: depth + 1, budget: &budget, control: control) }
        case .mapping(let values):
            var keys = Set<String>()
            for pair in values {
                guard let key = pair.key.string, keys.insert(key).inserted else { throw LocalError.invalid("YAML mapping keys must be unique strings.") }
                try validate(pair.key, depth: depth + 1, budget: &budget, control: control)
                try validate(pair.value, depth: depth + 1, budget: &budget, control: control)
            }
        }
    }
    static func preflightYAML(_ text: String) throws {
        for line in text.split(whereSeparator: \.isNewline) {
            let compactLevels = line.split(whereSeparator: \.isWhitespace).prefix(while: { $0 == "-" }).count
            if compactLevels > 64 { throw LocalError.invalid("YAML compact nesting exceeds the safety limit.") }
        }
        var depth = 0, quote: Character?, escaped = false, indentation = 0, lineStart = true, comment = false
        for char in text {
            if char == "\n" || char == "\r\n" { lineStart = true; indentation = 0; comment = false; continue }
            if comment { continue }
            if lineStart && (char == " " || char == "\t") {
                indentation += char == "\t" ? 8 : 1
                if indentation > 128 { throw LocalError.invalid("YAML indentation exceeds the safety limit.") }
                continue
            }
            lineStart = false
            if let current = quote {
                if escaped { escaped = false; continue }
                if char == "\\", current == "\"" { escaped = true; continue }
                if char == current { quote = nil }
                continue
            }
            if char == "#" { comment = true }
            else if char == "\"" || char == "'" { quote = char }
            else if char == "&" || char == "*" { throw LocalError.invalid("YAML anchors and aliases are disabled. Quote literal ampersands or asterisks in strings.") }
            else if char == "[" || char == "{" { depth += 1 }
            else if char == "]" || char == "}" { depth = max(0, depth - 1) }
            if depth > 64 { throw LocalError.invalid("YAML nesting exceeds the safety limit.") }
        }
    }
    static func quote(_ string: String, separator: String) -> String {
        if string.contains(separator) || string.contains("\"") || string.contains("\n") || string.contains("\r") {
            return "\"" + string.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        }
        return string
    }
    static func parseCSV(_ text: String, separator: Character, control: JobControl) throws -> [[String]] {
        var rows: [[String]] = [], row: [String] = [], field = "", quoted = false, afterQuote = false, skipLF = false
        var iterator = text.makeIterator(), current = iterator.next(), count = 0
        while let character = current {
            count += 1; if count % 4096 == 0 { try control.check() }
            let next = iterator.next()
            if skipLF && character == "\n" { skipLF = false; current = next; continue }
            skipLF = false
            if quoted {
                if character == "\"" {
                    if next == "\"" { field.append("\""); current = iterator.next(); continue }
                    quoted = false; afterQuote = true
                } else { field.append(character) }
            } else if character == separator {
                row.append(field); field = ""; afterQuote = false
            } else if character == "\r" || character == "\n" || character == "\r\n" {
                row.append(field); rows.append(row); row = []; field = ""; afterQuote = false; skipLF = character == "\r"
            } else if character == "\"" && field.isEmpty && !afterQuote { quoted = true }
            else {
                guard !afterQuote, character != "\"" else { throw LocalError.invalid("CSV contains malformed quotes.") }
                field.append(character)
            }
            guard row.count <= 1000, rows.count <= 100_000 else { throw LocalError.invalid("Table exceeds its row or column limit.") }
            current = next
        }
        guard !quoted else { throw LocalError.invalid("CSV has an unclosed quote.") }
        if !field.isEmpty || !row.isEmpty || afterQuote { row.append(field); rows.append(row) }
        return rows
    }
}
