const { getSupabaseAdminClient } = require('./supabase');

class ExpenseRepository {
  constructor(client = getSupabaseAdminClient()) {
    this.client = client;
  }

  async hasAccess(adminId) {
    const { data, error } = await this.client.from('admin_expense_access').select('admin_id').eq('admin_id', adminId).maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }

  async rpc(name, args) {
    const { data, error } = await this.client.rpc(name, args);
    if (!error) return data;

    const wrapped = new Error(error.message || 'Ошибка БД');
    wrapped.code = error.code || 'EXPENSE_ERROR';
    wrapped.statusCode =
      error.code === '42501' ? 403 :
      ['40001','23505','55000'].includes(error.code) ? 409 :
      error.code === 'P0002' ? 404 : 400;
    throw wrapped;
  }

  categories(actor) {
    return this.rpc('list_admin_expense_categories_v2', { p_actor_id: actor.id });
  }
  createCategory(name, actor) {
    return this.rpc('create_admin_expense_category_v2', { p_name: name, p_actor_id: actor.id, p_actor_name: actor.name });
  }
  renameCategory(id, name, actor) {
    return this.rpc('rename_admin_expense_category_v2', { p_id: id, p_name: name, p_actor_id: actor.id, p_actor_name: actor.name });
  }
  deleteCategory(id, actor) {
    return this.rpc('delete_admin_expense_category_v2', { p_id: id, p_actor_id: actor.id, p_actor_name: actor.name });
  }
  list(filters) {
    return this.rpc('list_admin_expenses_v2', { p_filters: filters });
  }
  get(id) {
    return this.rpc('get_admin_expense_v2', { p_id: id });
  }
  create(requestId, data, actor) {
    return this.rpc('save_admin_expense_v2', {
      p_id: null, p_request_id: requestId, p_version: null, p_data: data,
      p_actor_id: actor.id, p_actor_name: actor.name,
    });
  }
  update(id, version, data, actor) {
    return this.rpc('save_admin_expense_v2', {
      p_id: id, p_request_id: null, p_version: version, p_data: data,
      p_actor_id: actor.id, p_actor_name: actor.name,
    });
  }

  async attach(id, version, file, actor) {
    const objectPath = `${id}/${file.id}`;
    const bucketName = 'admin-expense-receipts-v2';
    const bucket = this.client.storage.from(bucketName);

    const { error: uploadError } = await bucket.upload(objectPath, file.bytes, {
      contentType: file.mime,
      upsert: false,
    });
    if (uploadError) throw uploadError;

    try {
      return await this.rpc('attach_admin_expense_file_v2', {
        p_id: id,
        p_version: version,
        p_file: {
          id: file.id, name: file.name, mime: file.mime, size: file.size,
          path: objectPath, bucket: bucketName,
        },
        p_actor_id: actor.id,
        p_actor_name: actor.name,
      });
    } catch (error) {
      const confirmed = await this.get(id).catch(() => null);
      if (confirmed?.attachments?.some((item) => String(item.id) === String(file.id))) return confirmed;
      await bucket.remove([objectPath]).catch(() => {});
      throw error;
    }
  }

  async file(id, fileId) {
    const row = await this.get(id);
    const file = row?.attachments?.find((item) => String(item.id) === String(fileId));
    if (!file) return null;
    const bucketName = file.bucket || 'admin-expense-receipts-v2';
    const path = file.path || `${id}/${fileId}`;
    const { data, error } = await this.client.storage.from(bucketName).download(path);
    if (error) throw error;
    return { name: file.name || 'attachment', mime: file.mime || 'application/octet-stream', bytes: Buffer.from(await data.arrayBuffer()) };
  }
}

module.exports = { ExpenseRepository };
