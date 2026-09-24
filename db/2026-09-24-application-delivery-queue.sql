-- Durable queue claim for public application delivery.

create or replace function public.claim_application_delivery_queue(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns setof public.application_delivery_queue
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  with picked as (
    select q.id
    from public.application_delivery_queue q
    where (
      q.status in ('pending','retry')
      and q.next_attempt_at <= now()
    ) or (
      q.status = 'leased'
      and q.lease_until < now()
    )
    order by q.id
    for update skip locked
    limit greatest(1, least(coalesce(p_limit,10),100))
  )
  update public.application_delivery_queue q
  set
    status = 'leased',
    attempts = q.attempts + 1,
    lease_token = gen_random_uuid(),
    lease_until = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds,120),3600)))
  from picked
  where q.id = picked.id
  returning q.*;
end;
$$;

revoke all on function public.claim_application_delivery_queue(text,integer,integer)
from public, anon, authenticated;

grant execute on function public.claim_application_delivery_queue(text,integer,integer)
to service_role;
