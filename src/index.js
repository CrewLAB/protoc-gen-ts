"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const plugin = require("./compiler/plugin.js");
const path = require("path");
const fs = require("fs");
const ts = require("typescript");
const type = require("./type.js");
const descriptor = require("./descriptor.js");
const rpc = require("./rpc.js");
const op = require("./option");
function createImport(identifier, moduleSpecifier) {
    return ts.factory.createImportDeclaration(undefined, undefined, ts.factory.createImportClause(false, ts.factory.createNamespaceImport(identifier), undefined), ts.factory.createStringLiteral(moduleSpecifier));
}
function replaceExtension(filename, extension = ".ts") {
    return filename.replace(/\.[^/.]+$/, extension);
}
const request = plugin.CodeGeneratorRequest.deserialize(new Uint8Array(fs.readFileSync(0)));
const response = new plugin.CodeGeneratorResponse({
    supported_features: plugin.CodeGeneratorResponse.Feature.FEATURE_PROTO3_OPTIONAL,
    file: [],
});
const options = op.parse(request.parameter);
type.initialize(options);
descriptor.initialize(options);
for (const descriptor of request.proto_file) {
    type.preprocess(descriptor, descriptor.name, `.${descriptor.package ?? ""}`);
}
for (const fileDescriptor of request.proto_file) {
    const name = replaceExtension(fileDescriptor.name);
    const pbIdentifier = ts.factory.createUniqueName("pb");
    const grpcIdentifier = ts.factory.createUniqueName("grpc");
    // Will keep track of import statements
    const importStatements = [
        // Create all named imports from dependencies
        ...fileDescriptor.dependency.map((dependency) => {
            const identifier = ts.factory.createUniqueName(`dependency`);
            const moduleSpecifier = replaceExtension(dependency, "");
            type.setIdentifierForDependency(dependency, identifier);
            return createImport(identifier, `./${path.relative(path.dirname(fileDescriptor.name), moduleSpecifier)}`);
        }),
    ];
    // Create all messages recursively
    let statements = [
        // Process enums
        ...fileDescriptor.enum_type.map((enumDescriptor) => descriptor.createEnum(enumDescriptor)),
        // Process root messages
        ...fileDescriptor.message_type.flatMap((messageDescriptor) => descriptor.processDescriptorRecursively(fileDescriptor, messageDescriptor, pbIdentifier, options.no_namespace)),
    ];
    if (statements.length) {
        importStatements.push(createImport(pbIdentifier, "google-protobuf"));
    }
    if (fileDescriptor.service.length) {
        // Import grpc only if there is service statements
        importStatements.push(createImport(grpcIdentifier, options.grpc_package));
        statements.push(...rpc.createGrpcInterfaceType(grpcIdentifier));
        // Create all services and clients
        for (const serviceDescriptor of fileDescriptor.service) {
            statements.push(rpc.createUnimplementedServer(fileDescriptor, serviceDescriptor, grpcIdentifier));
            statements.push(rpc.createServiceClient(fileDescriptor, serviceDescriptor, grpcIdentifier, options));
        }
    }
    const { major = 0, minor = 0, patch = 0 } = request.compiler_version ?? {};
    const comments = [
        `Generated by the protoc-gen-ts.  DO NOT EDIT!`,
        `compiler version: ${major}.${minor}.${patch}`,
        `source: ${fileDescriptor.name}`,
        `git: https://github.com/thesayyn/protoc-gen-ts`,
    ];
    if (fileDescriptor.options?.deprecated) {
        comments.push("@deprecated");
    }
    const doNotEditComment = ts.factory.createJSDocComment(comments.join("\n"));
    // Wrap statements within the namespace
    if (fileDescriptor.package && !options.no_namespace) {
        statements = [
            doNotEditComment,
            ...importStatements,
            descriptor.createNamespace(fileDescriptor.package, statements),
        ];
    }
    else {
        statements = [doNotEditComment, ...importStatements, ...statements];
    }
    const sourcefile = ts.factory.createSourceFile(statements, ts.factory.createToken(ts.SyntaxKind.EndOfFileToken), ts.NodeFlags.None);
    // @ts-ignore
    sourcefile.identifiers = new Set();
    const content = ts
        .createPrinter({
        newLine: ts.NewLineKind.LineFeed,
        omitTrailingSemicolon: true,
    })
        .printFile(sourcefile);
    response.file.push(new plugin.CodeGeneratorResponse.File({
        name,
        content,
    }));
    // after each iteration we need to clear the dependency map to prevent accidental
    // misuse of identifiers
    type.resetDependencyMap();
}
process.stdout.write(response.serialize());
