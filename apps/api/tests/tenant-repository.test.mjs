import assert from "node:assert/strict";
import test from "node:test";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import { BaseTenantRepository } from "../dist/infrastructure/tenant-repository.js";

const db = new Kysely({ dialect: {
  createAdapter: () => new PostgresAdapter(), createDriver: () => new DummyDriver(),
  createIntrospector: (database) => new PostgresIntrospector(database), createQueryCompiler: () => new PostgresQueryCompiler()
} });
// An unrelated future module can inherit the pattern without depending on OrganizationStore.
class ExpenseRepository extends BaseTenantRepository {
  findById(id) { return this.find(db.selectFrom("expenses")).selectAll().where("id", "=", id); }
  updateById(id) { return this.update(db.updateTable("expenses")).set({ name: "Updated" }).where("id", "=", id); }
  deleteById(id) { return this.delete(db.deleteFrom("expenses")).where("id", "=", id); }
  insert(input) { return db.insertInto("expenses").values(this.insertValues(input)); }
  aliased(id) { return this.find(db.selectFrom("expenses as e"), "e.organization_id").selectAll().where("e.id", "=", id); }
  verify(resource) { return this.ensureOrganization(resource); }
}
const context = { organizationId: "tenant-a", userId: "user-a" };
const repository = new ExpenseRepository(context);
test("find, update, and delete parameterize tenant scope alongside resource identity", () => {
  for (const method of ["findById", "updateById", "deleteById"]) {
    const query = repository[method]("resource-b").compile();
    assert.match(query.sql, /where "organization_id" = \$\d and "id" = \$\d/);
    assert.deepEqual(query.parameters.slice(-2), ["tenant-a", "resource-b"]);
    assert.doesNotMatch(query.sql, /tenant-a|resource-b/);
  }
});
test("returned-resource guard fails closed for a foreign tenant", () => {
  const record = { organizationId: "tenant-a", id: "expense" };
  assert.equal(repository.verify(record), record);
  assert.throws(() => repository.verify({ ...record, organizationId: "tenant-b" }), /invalid organization scope/);
});

test("scope is captured once and rejects missing identity or organization", () => {
  for (const invalid of [{ ...context, userId: " " }, { ...context, organizationId: "" }]) {
    assert.throws(() => new ExpenseRepository(invalid), /Authenticated tenant context is required/);
  }
  const mutable = { ...context };
  const scoped = new ExpenseRepository(mutable);
  mutable.organizationId = "tenant-b";
  mutable.userId = "user-b";
  assert.deepEqual(scoped.findById("resource").compile().parameters, ["tenant-a", "resource"]);
  assert.deepEqual(scoped.aliased("resource").compile().parameters, ["tenant-a", "resource"]);
});

test("inserts derive tenant scope internally and reject supplied ownership", () => {
  const query = repository.insert({ id: "resource", name: "Expense" }).compile();
  assert.match(query.sql, /"organization_id"/);
  assert.deepEqual(query.parameters, ["resource", "Expense", "tenant-a"]);
  for (const organization_id of ["tenant-b", "tenant-a", undefined]) {
    assert.throws(() => repository.insert({ id: "resource", organization_id }), /cannot be supplied/);
  }
});
